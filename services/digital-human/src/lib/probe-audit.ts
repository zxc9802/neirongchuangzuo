import { logServerError } from "./server/safe-log";
import fs from "fs";
import path from "path";
import type { NextRequest } from "next/server";

export type ProbeCategory =
  | "closed_surface"
  | "closed_storage"
  | "provider_keyword"
  | "path_traversal"
  | "private_path_injection"
  | "provider_engine_name";

export interface ProbeFinding {
  categories: ProbeCategory[];
  signals: string[];
}

export interface ProbeAuditRecord {
  at: string;
  method: string;
  path: string;
  categories: ProbeCategory[];
  signals: string[];
  ip: string;
  userAgent: string;
  hasSessionCookie: boolean;
}

const CLOSED_SURFACES = [
  "/settings",
  "/mcp",
  "/api/settings",
  "/api/mcp",
  "/api/cos/test",
];

const PROVIDER_KEYWORD_RE =
  /\b(?:heygen|pixverse|openlux|indextts|index[\s_-]?tts|fal\.ai|veed|302\.ai|myqcloud|qcloud)\b/i;

const TRAVERSAL_RE =
  /\.\.|%2e%2e|\.settings\.json|\.env(?:\.|$)|\/etc\/|\/proc\/|\.heygen-mcp|\.tasks\.json|\.avatars\.json|\.voices\.json/i;

const PRIVATE_PATH_RE =
  /(?:^|[\\/])(?:app|\.runtime|\.settings|\.env|proc|etc)(?:[\\/]|$)|^(?:\/|[a-z]:\\)/i;

const PROVIDER_ENGINE_NAMES = new Set([
  "heygen",
  "pixverse",
  "veed",
  "openlux",
  "indextts",
  "index-tts",
  "fal",
]);

const PUBLIC_PROCESSING_INPUT =
  /^\/jobs\/input\/[a-f0-9]{48}\/(?:source-video\.mp4|voice-track\.wav|speaker-reference\.(?:mp3|wav|m4a)|emotion-reference\.wav)$/;

const writeWindows = new Map<string, { startedAt: number; count: number }>();
const WRITE_WINDOW_MS = 60_000;
const MAX_WRITES_PER_WINDOW = 40;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function add(finding: ProbeFinding, category: ProbeCategory, signal: string) {
  finding.categories.push(category);
  finding.signals.push(signal);
}

function emptyFinding(): ProbeFinding {
  return { categories: [], signals: [] };
}

function finalize(finding: ProbeFinding): ProbeFinding | null {
  finding.categories = unique(finding.categories);
  finding.signals = unique(finding.signals).slice(0, 12);
  return finding.categories.length ? finding : null;
}

export function classifyProbePath(pathname: string, search = ""): ProbeFinding | null {
  const finding = emptyFinding();
  const haystack = `${pathname}${search}`;

  if (
    CLOSED_SURFACES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    )
  ) {
    add(finding, "closed_surface", "closed-management-surface");
  }

  if (pathname.startsWith("/jobs/") || pathname.startsWith("/uploads/")) {
    if (!PUBLIC_PROCESSING_INPUT.test(pathname)) {
      add(finding, "closed_storage", "closed-direct-storage");
    }
  }

  if (PROVIDER_KEYWORD_RE.test(haystack)) {
    add(finding, "provider_keyword", "provider-or-vendor-token");
  }

  if (TRAVERSAL_RE.test(haystack)) {
    add(finding, "path_traversal", "path-traversal-or-secret-file");
  }

  return finalize(finding);
}

export function classifyProbePayload(payload: unknown): ProbeFinding | null {
  if (!payload || typeof payload !== "object") return null;
  const finding = emptyFinding();
  const record = payload as Record<string, unknown>;

  const engine = typeof record.engine === "string" ? record.engine.trim().toLowerCase() : "";
  const provider =
    typeof record.lipsyncProvider === "string"
      ? record.lipsyncProvider.trim().toLowerCase()
      : "";
  if (
    (engine && PROVIDER_ENGINE_NAMES.has(engine)) ||
    (provider && PROVIDER_ENGINE_NAMES.has(provider))
  ) {
    add(finding, "provider_engine_name", "raw-provider-engine-name");
  }

  for (const key of ["videoPath", "videoUrl", "audioUrl", "coverUrl", "audioPath"]) {
    const value = record[key];
    if (typeof value !== "string" || !value.trim()) continue;
    if (PRIVATE_PATH_RE.test(value) || TRAVERSAL_RE.test(value)) {
      add(finding, "private_path_injection", `injected-${key}`);
    }
    if (PROVIDER_KEYWORD_RE.test(value)) {
      add(finding, "provider_keyword", `provider-url-in-${key}`);
    }
  }

  return finalize(finding);
}

export function classifyProbeRequest(req: NextRequest): ProbeFinding | null {
  return classifyProbePath(req.nextUrl.pathname, req.nextUrl.search);
}

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
}

function allowDiskWrite(ip: string): boolean {
  const now = Date.now();
  const current = writeWindows.get(ip);
  if (!current || now - current.startedAt >= WRITE_WINDOW_MS) {
    writeWindows.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= MAX_WRITES_PER_WINDOW) return false;
  current.count += 1;
  return true;
}

function auditPath(): string {
  return path.join(process.cwd(), ".runtime", "state", "probe-audit.jsonl");
}

function toRecord(req: NextRequest, finding: ProbeFinding): ProbeAuditRecord {
  return {
    at: new Date().toISOString(),
    method: req.method,
    path: `${req.nextUrl.pathname}${req.nextUrl.search}`.slice(0, 240),
    categories: finding.categories,
    signals: finding.signals,
    ip: clientIp(req),
    userAgent: (req.headers.get("user-agent") || "").slice(0, 180),
    hasSessionCookie: Boolean(req.cookies.getAll().length),
  };
}

function persist(record: ProbeAuditRecord) {
  try {
    const file = auditPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // 探测审计失败不得影响正常请求
  }
}

async function notifyWebhook(record: ProbeAuditRecord) {
  const webhook = process.env.PROBE_AUDIT_WEBHOOK_URL?.trim();
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "shuziren-probe-audit", ...record }),
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    // ignore
  }
}

export function recordProbe(req: NextRequest, finding: ProbeFinding): ProbeAuditRecord {
  const record = toRecord(req, finding);
  logServerError("security.probe_detected", undefined, "warn");
  if (allowDiskWrite(record.ip)) {
    persist(record);
    void notifyWebhook(record);
  }
  return record;
}

export function inspectAndRecordProbe(
  req: NextRequest,
  payload?: unknown
): ProbeFinding | null {
  const pathFinding = classifyProbeRequest(req);
  const bodyFinding = payload === undefined ? null : classifyProbePayload(payload);
  if (!pathFinding && !bodyFinding) return null;

  const merged: ProbeFinding = {
    categories: unique([
      ...(pathFinding?.categories || []),
      ...(bodyFinding?.categories || []),
    ]),
    signals: unique([
      ...(pathFinding?.signals || []),
      ...(bodyFinding?.signals || []),
    ]),
  };
  recordProbe(req, merged);
  return merged;
}
