import { NextRequest } from "next/server";
import { VoiceStore } from "@/lib/store/voice-store";
import { servePrivateMedia } from "@/lib/server/media-response";
import { isOwnedUploadSource } from "@/lib/server/upload-policy";
import {
  canViewAllMedia,
  mediaNotFoundResponse,
  resolveAccessContext,
  unauthorizedResponse,
} from "@/lib/access-control";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await resolveAccessContext(req);
  if (access.isolated && !access.userId) return unauthorizedResponse();

  const { id } = await params;
  const voice = VoiceStore.get(id);
  if (
    !voice ||
    (!voice.isDefault && !canViewAllMedia(access) && voice.userId !== access.userId)
  ) {
    return mediaNotFoundResponse();
  }
  const source = voice.audioPath || voice.audioUrl;
  if (
    !voice.isDefault &&
    !isOwnedUploadSource({ source, userId: voice.userId, folder: "voices" })
  ) {
    return mediaNotFoundResponse();
  }
  return servePrivateMedia(req, source, {
    contentType: "audio/mpeg",
    allowConfiguredReference: Boolean(voice.isDefault),
  });
}
