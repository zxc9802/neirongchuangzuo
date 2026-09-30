import { NextRequest } from "next/server";
import { AvatarStore } from "@/lib/store/avatar-store";
import { servePrivateMedia } from "@/lib/server/media-response";
import { avatarCoverVersion } from "@/lib/server/public-data";
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
  const avatar = AvatarStore.get(id);
  if (!avatar || (!canViewAllMedia(access) && avatar.userId !== access.userId)) {
    return mediaNotFoundResponse();
  }

  const kind = req.nextUrl.searchParams.get("kind");
  if (kind === "cover") {
    if (!isOwnedUploadSource({ source: avatar.coverUrl, userId: avatar.userId, folder: "thumbnails" })) {
      return mediaNotFoundResponse();
    }
    // Uploaded and extracted covers have unique source keys. Revalidate access on
    // every visit, but skip the object-storage round trip for unchanged images.
    const etag = `"${avatarCoverVersion(avatar)}"`;
    const headers = {
      "Cache-Control": "private, no-cache",
      ETag: etag,
    };
    const validators = req.headers.get("if-none-match")?.split(",").map(value => value.trim().replace(/^W\//, ""));
    if (validators?.includes(etag)) {
      return new Response(null, { status: 304, headers });
    }
    const response = await servePrivateMedia(req, avatar.coverUrl, { contentType: "image/jpeg" });
    if (response.status === 200) {
      for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    }
    return response;
  }
  const videoSource = avatar.videoPath || avatar.videoUrl;
  if (!isOwnedUploadSource({ source: videoSource, userId: avatar.userId, folder: "videos" })) {
    return mediaNotFoundResponse();
  }
  return servePrivateMedia(req, videoSource, { contentType: "video/mp4" });
}
