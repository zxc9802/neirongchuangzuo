import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import { servePrivateMedia } from "@/lib/server/media-response";

const PUBLIC_INPUT_FILES = new Set([
  "source-video.mp4",
  "voice-track.wav",
  "speaker-reference.mp3",
  "speaker-reference.wav",
  "speaker-reference.m4a",
  "emotion-reference.wav",
]);
const PROVIDER_TOKEN_RE = /^[a-f0-9]{48}$/;
const PROVIDER_INPUT_TTL_MS = 6 * 60 * 60 * 1000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> }
) {
  const { slug } = await params;
  if (
    slug.length !== 3 ||
    slug[0] !== "input" ||
    !PROVIDER_TOKEN_RE.test(slug[1]) ||
    !PUBLIC_INPUT_FILES.has(slug[2])
  ) {
    return new Response("Not found", { status: 404 });
  }

  const token = slug[1];
  const fileName = slug[2];
  const filePath = path.join(process.cwd(), ".runtime", "provider-input", token, fileName);
  if (!fs.existsSync(filePath)) return new Response("Not found", { status: 404 });
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || Date.now() - stat.mtimeMs > PROVIDER_INPUT_TTL_MS) {
    try {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    } catch {}
    return new Response("Not found", { status: 404 });
  }

  return servePrivateMedia(req, filePath, {
    contentType: fileName.endsWith(".mp4")
      ? "video/mp4"
      : fileName.endsWith(".m4a")
        ? "audio/mp4"
        : fileName.endsWith(".mp3")
          ? "audio/mpeg"
          : "audio/wav",
  });
}
