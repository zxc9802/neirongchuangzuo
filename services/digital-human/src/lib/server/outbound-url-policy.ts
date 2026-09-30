import "server-only";

import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";

export type OutboundUrlPolicy = {
  name: string;
  allowedHosts: string[];
  maxRedirects?: number;
  sensitiveHeaders?: boolean;
};

function normalizedHost(value: string): string {
  return value.toLowerCase().replace(/\.$/, "");
}

function configuredHosts(variable: string, defaults: string[]): string[] {
  return [...new Set([
    ...defaults,
    ...(process.env[variable] || "").split(","),
  ].map((host) => normalizedHost(host.trim())).filter(Boolean))];
}

export function providerUrlPolicy(
  provider: "indextts" | "heygen" | "pixverse" | "fal",
): OutboundUrlPolicy {
  if (provider === "indextts") {
    return { name: provider, allowedHosts: configuredHosts("INDEXTTS_DOWNLOAD_HOSTS", ["302.ai"]) };
  }
  if (provider === "heygen") {
    return { name: provider, allowedHosts: configuredHosts("HEYGEN_DOWNLOAD_HOSTS", ["heygen.com", "heygen.ai"]) };
  }
  if (provider === "pixverse") {
    return { name: provider, allowedHosts: configuredHosts("PIXVERSE_DOWNLOAD_HOSTS", ["openlux.ai", "pixverse.ai", "pixverseai.cn"]) };
  }
  return { name: provider, allowedHosts: configuredHosts("FAL_DOWNLOAD_HOSTS", ["fal.ai", "fal.run", "fal.media"]) };
}

export function exactHostUrlPolicy(url: string, name = "trusted-storage"): OutboundUrlPolicy {
  return { name, allowedHosts: [normalizedHost(new URL(url).hostname)] };
}

function ipv4IsPrivateOrReserved(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

export function isPrivateOrReservedAddress(address: string): boolean {
  const value = address.toLowerCase().split("%")[0];
  const family = net.isIP(value);
  if (family === 4) return ipv4IsPrivateOrReserved(value);
  if (family !== 6) return true;
  if (value.startsWith("::ffff:")) {
    return ipv4IsPrivateOrReserved(value.slice("::ffff:".length));
  }
  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value) ||
    value.startsWith("2001:db8:")
  );
}

function hostMatches(hostname: string, allowed: string): boolean {
  return hostname === allowed || hostname.endsWith(`.${allowed}`);
}

async function resolveOutboundUrl(
  value: string,
  policy: OutboundUrlPolicy,
): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${policy.name} returned an invalid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${policy.name} URL must be credential-free HTTPS`);
  }
  const hostname = normalizedHost(url.hostname);
  if (!policy.allowedHosts.some((allowed) => hostMatches(hostname, normalizedHost(allowed)))) {
    throw new Error(`${policy.name} URL host is not allow-listed`);
  }
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedAddress(hostname)) throw new Error(`${policy.name} URL resolved to a non-public address`);
    return { url, address: hostname, family: net.isIP(hostname) };
  }
  const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateOrReservedAddress(address))) {
    throw new Error(`${policy.name} URL resolved to a non-public address`);
  }
  return { url, address: addresses[0].address, family: addresses[0].family };
}

export async function validateOutboundUrl(
  value: string,
  policy: OutboundUrlPolicy,
): Promise<URL> {
  return (await resolveOutboundUrl(value, policy)).url;
}

export function assertSameOrigin(candidate: string, trustedBase: string): void {
  const candidateUrl = new URL(candidate);
  const trustedUrl = new URL(trustedBase);
  if (candidateUrl.origin !== trustedUrl.origin) {
    throw new Error("Provider control-plane URL changed origin");
  }
}

function canPinRequestBody(body: BodyInit | null | undefined): boolean {
  return (
    body == null ||
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

function fetchPinnedHttps(
  resolved: { url: URL; address: string; family: number },
  init: RequestInit,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request = https.request(
      resolved.url,
      {
        method: init.method || "GET",
        headers,
        signal: init.signal || undefined,
        servername: resolved.url.hostname,
        lookup: ((_hostname: string, options: { all?: boolean }, callback: Function) => {
          if (options?.all) {
            callback(null, [{ address: resolved.address, family: resolved.family }]);
            return;
          }
          callback(null, resolved.address, resolved.family);
        }) as any,
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        const status = incoming.statusCode || 500;
        const hasNoBody = status === 204 || status === 205 || status === 304;
        if (hasNoBody) incoming.resume();
        resolve(new Response(
          hasNoBody ? null : (Readable.toWeb(incoming) as BodyInit),
          { status, statusText: incoming.statusMessage, headers: responseHeaders },
        ));
      },
    );
    request.on("error", reject);
    const body = init.body;
    if (body != null) {
      if (typeof body === "string") request.write(body);
      else if (body instanceof URLSearchParams) request.write(body.toString());
      else if (body instanceof ArrayBuffer) request.write(Buffer.from(body));
      else if (ArrayBuffer.isView(body)) {
        request.write(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
      }
    }
    request.end();
  });
}

export async function fetchWithOutboundUrlPolicy(
  value: string,
  init: RequestInit,
  policy: OutboundUrlPolicy,
): Promise<Response> {
  let current = await resolveOutboundUrl(value, policy);
  const initialOrigin = current.url.origin;
  const maxRedirects = policy.maxRedirects ?? 4;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    if (policy.sensitiveHeaders && current.url.origin !== initialOrigin) {
      throw new Error(`${policy.name} credential-bearing redirect changed origin`);
    }
    const response = canPinRequestBody(init.body)
      ? await fetchPinnedHttps(current, init)
      : await fetch(current.url, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects === maxRedirects) throw new Error(`${policy.name} redirect limit exceeded`);
    const location = response.headers.get("location");
    if (!location) throw new Error(`${policy.name} redirect omitted Location`);
    await response.body?.cancel().catch(() => undefined);
    current = await resolveOutboundUrl(new URL(location, current.url).toString(), policy);
  }
  throw new Error(`${policy.name} redirect limit exceeded`);
}
