"""Native-resolution face inputs, mouth compositing and measured AV alignment.

All inputs are local paths supplied by the server. Provider submission remains in
TypeScript; this worker never accesses the network or retries paid generation.
"""
import collections
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess as sp
import sys
import time
import wave

import cv2
import numpy as np
from scipy.ndimage import median_filter

MODELS = Path(os.environ.get("LIPSYNC_MODEL_DIR", "/opt/lipsync/models"))
FPS = 30
PREPAD = 0.6
POSTPAD = 0.3
cv2.setNumThreads(2)


class QualityError(Exception):
    def __init__(self, message, code="LIPSYNC_FACE_INPUT"):
        super().__init__(message)
        self.code = code


def command(args):
    return sp.check_output(args, stderr=sp.PIPE)


def ffmpeg(args):
    return command(["ffmpeg", "-v", "error", "-y", "-threads", "2", *args])


def probe(file):
    data = json.loads(command(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(file)]))
    video = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    if not video:
        return {"duration": float(data["format"]["duration"])}
    w, h = video["width"], video["height"]
    sar = video.get("sample_aspect_ratio", "1:1").split(":")
    if len(sar) == 2 and float(sar[1]) > 0:
        w = round(w * float(sar[0]) / float(sar[1]))
    rotation = next((s.get("rotation", 0) for s in video.get("side_data_list", []) if "rotation" in s), 0)
    if abs(rotation) % 180 == 90:
        w, h = h, w
    return {"width": w // 2 * 2, "height": h // 2 * 2,
            "duration": float(video.get("duration", data["format"]["duration"]))}


def frames(file, width, height, fps=FPS, duration=None, loop=False, extra=""):
    args = ["ffmpeg", "-v", "error", "-threads", "2"]
    if loop:
        args += ["-stream_loop", "-1"]
    args += ["-i", str(file)]
    if duration is not None:
        args += ["-t", str(duration)]
    args += ["-vf", f"{extra + ',' if extra else ''}scale={width}:{height},setsar=1,fps={fps}",
             "-an", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    proc = sp.Popen(args, stdout=sp.PIPE, stderr=sp.DEVNULL)
    try:
        while True:
            raw = proc.stdout.read(width * height * 3)
            if not raw:
                break
            if len(raw) != width * height * 3:
                raise QualityError("Incomplete decoded frame", "LIPSYNC_MEDIA")
            yield np.frombuffer(raw, np.uint8).reshape(height, width, 3)
        if proc.wait() != 0:
            raise QualityError("Video decode failed", "LIPSYNC_MEDIA")
    finally:
        proc.stdout.close()
        if proc.poll() is None:
            proc.terminate()
        proc.wait()


def track(file, duration=None, loop=False):
    info = probe(file)
    scale = min(1, 1280 / max(info["width"], info["height"]))
    w, h = int(info["width"] * scale) // 2 * 2, int(info["height"] * scale) // 2 * 2
    detector = cv2.FaceDetectorYN.create(str(MODELS / "yunet.onnx"), "", (w, h), 0.75)
    rows, gap = [], 0
    repeated = {} if loop and duration is not None and duration > info["duration"] else None
    for frame in frames(file, w, h, duration=duration, loop=loop):
        # Reuse only byte-identical decoded frames. This also handles VFR loop
        # boundaries without guessing frame indices; every quality gate below
        # still checks the complete output track, including each loop join.
        key = hashlib.sha256(frame).digest() if repeated is not None else None
        if repeated is not None and key in repeated:
            found = repeated[key]
        else:
            _, found = detector.detect(frame)
            if repeated is not None:
                repeated[key] = None if found is None else found.copy()
        if found is None:
            rows.append(None)
            gap += 1
            if gap > 5:
                raise QualityError("Face missing for more than five frames")
            continue
        # Only native faces large enough for this workflow are candidates.
        # A brief hand/background detection must not displace the usable face.
        if len(found) > 1:
            found = found[found[:, 2] * info["width"] / w >= 80]
        if len(found) != 1:
            raise QualityError("More than one face in the source")
        row = found[0, :14].astype(float)
        row[0::2] *= info["width"] / w
        row[1::2] *= info["height"] / h
        rows.append(row)
        gap = 0
    valid = [i for i, row in enumerate(rows) if row is not None]
    if len(valid) < max(1, len(rows) * 0.95):
        raise QualityError("Insufficient face coverage")
    data = np.stack([rows[i] for i in valid])
    data = np.column_stack([np.interp(np.arange(len(rows)), valid, data[:, k]) for k in range(14)])
    # Only short detector gaps are interpolated; large head jumps/cuts cannot be
    # hidden by smoothing, because they invalidate fixed-frame compositing.
    centers = data[:, :2] + data[:, 2:4] / 2
    if np.any(np.linalg.norm(np.diff(centers, axis=0), axis=1) > data[1:, 2] * 0.5):
        raise QualityError("Face track jumps or source contains a cut")
    return info, median_filter(data, size=(3, 1), mode="nearest")


def crop_plan(info, data):
    widths, heights = data[:, 2], data[:, 3]
    if np.min(widths) < 80:
        raise QualityError("Native face resolution is too small")
    left, top = data[:, :2].min(axis=0)
    right, bottom = (data[:, :2] + data[:, 2:4]).max(axis=0)
    side = math.ceil(max(widths.max() * 3.5, heights.max() * 2.8,
                         right - left + widths.max(), bottom - top + heights.max()) / 64) * 64
    side = min(side, info["width"], info["height"])
    x = int(np.clip((left + right - side) / 2, 0, info["width"] - side)) // 2 * 2
    y = int(np.clip((top + bottom - side) / 2, 0, info["height"] - side)) // 2 * 2
    out = min(768, side)
    if left < x or right > x + side or top < y or bottom > y + side or widths.min() * out / side < 96:
        raise QualityError("Face motion/resolution cannot fit a useful close-up")
    return {"x": x, "y": y, "size": side, "outputSize": out}


def pad_audio(source, target):
    with wave.open(str(source), "rb") as src:
        params = src.getparams()
        pcm = src.readframes(params.nframes)
    if params.sampwidth != 2 or params.comptype != "NONE":
        raise QualityError("Expected PCM16 narration", "LIPSYNC_MEDIA")
    silence_unit = bytes(params.sampwidth * params.nchannels)
    with wave.open(str(target), "wb") as dst:
        dst.setparams(params)
        dst.writeframes(silence_unit * round(PREPAD * params.framerate) + pcm + silence_unit * round(POSTPAD * params.framerate))
    return params.nframes / params.framerate


def prepare(req):
    job = Path(req["jobDir"])
    duration = float(req["durationSeconds"])
    if duration < 1.2:
        raise QualityError("Narration is too short to measure reliably", "LIPSYNC_INPUT_DURATION")
    # Check the full inference runtime before the server submits paid work.
    load_syncnet()
    info, data = track(req["inputVideoPath"], duration=duration, loop=True)
    crop = crop_plan(info, data)
    x, y, size, out = (crop[k] for k in ["x", "y", "size", "outputSize"])
    # Crop BEFORE reducing resolution. FFmpeg autorotates before this filter.
    # Lower CRF offsets the faster preset's compression loss in facial detail.
    ffmpeg(["-stream_loop", "-1", "-i", req["inputVideoPath"], "-an", "-vf",
            f"scale={info['width']}:{info['height']},setsar=1,fps=30,trim=duration={duration},setpts=PTS-STARTPTS,"
            f"crop={size}:{size}:{x}:{y},scale={out}:{out}:flags=lanczos,"
            f"tpad=start_duration={PREPAD}:stop_duration={POSTPAD}:start_mode=clone:stop_mode=clone",
            "-t", str(duration + PREPAD + POSTPAD), "-c:v", "libx264", "-threads", "2", "-preset", "veryfast",
            "-crf", "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(job / "face-input.mp4")])
    exact_duration = pad_audio(req["audioPath"], job / "face-audio.wav")
    if abs(exact_duration - duration) > 1 / FPS:
        raise QualityError("Narration duration changed", "LIPSYNC_MEDIA")
    manifest = {"version": 1, "fps": FPS, "durationSeconds": duration,
                "prepadSeconds": PREPAD, "postpadSeconds": POSTPAD, "source": info,
                "crop": crop, "track": np.round(data, 4).tolist()}
    (job / "face-manifest.json").write_text(json.dumps(manifest))
    return {"durationSeconds": duration + PREPAD + POSTPAD, "crop": crop}


def frame_offset(source, rendered, prepad_frames):
    ids = np.arange(3, min(len(source) - 3, len(rendered) - prepad_frames - 3))
    if len(ids) < 12:
        raise QualityError("Too few frames for registration", "LIPSYNC_MEDIA")
    if np.std(source[ids], axis=0).mean() < 0.5:
        return 0  # Static background cannot identify a temporal shift.
    distances = np.stack([np.mean((source[ids] - rendered[ids + prepad_frames + offset]) ** 2, axis=(1, 2, 3))
                          for offset in range(-3, 4)], axis=1)
    # Compression/resizing can swap two adjacent per-frame nearest matches.
    # Compare one-second blocks, then apply ONE offset to the entire clip.
    blocks = [int(distances[i:i + FPS].mean(axis=0).argmin())
              for i in range(0, len(ids) - 11, FPS)]
    best = int(distances.mean(axis=0).argmin())
    if best in (0, 6) or max(blocks) - min(blocks) > 1:
        raise QualityError("Provider frame correspondence is not stable", "LIPSYNC_MEDIA")
    return best - 3


def blend_mouth(frame, patch, x, y, cx, cy, rx, ry):
    h, w = patch.shape[:2]
    left, right = max(0, math.floor(cx - rx)), min(w, math.ceil(cx + rx))
    top, bottom = max(0, math.floor(cy - ry)), min(h, math.ceil(cy + ry))
    result = frame.copy()
    if left >= right or top >= bottom:
        return result
    yy, xx = np.mgrid[top:bottom, left:right]
    radius = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
    alpha = np.clip((1 - radius) / 0.3, 0, 1)
    alpha = (alpha * alpha * (3 - 2 * alpha))[:, :, None]
    region = result[y + top:y + bottom, x + left:x + right]
    result[y + top:y + bottom, x + left:x + right] = np.clip(
        region * (1 - alpha) + patch[top:bottom, left:right] * alpha, 0, 255).astype(np.uint8)
    return result


def composite(req):
    started = time.perf_counter()
    job = Path(req["jobDir"])
    manifest = json.loads((job / "face-manifest.json").read_text())
    base = probe(job / "source-video.mp4")
    raw = probe(req["renderedPath"])
    expected = manifest["durationSeconds"] + PREPAD + POSTPAD
    if abs(raw["duration"] - expected) > 0.15 or abs(raw["width"] / raw["height"] - 1) > 0.01:
        raise QualityError("Provider changed duration or crop geometry", "LIPSYNC_MEDIA")
    scale_x = base["width"] / manifest["source"]["width"]
    scale_y = base["height"] / manifest["source"]["height"]
    c = manifest["crop"]
    x, y = round(c["x"] * scale_x), round(c["y"] * scale_y)
    w, h = round(c["size"] * scale_x), round(c["size"] * scale_y)
    reference = job / "face-input.mp4"
    if reference.exists():
        # Compare to the exact provider input. Re-cropping the separately
        # resized full frame adds spatial/loop-rounding differences that look
        # like temporal drift even when the provider preserved every frame.
        source_thumbs = np.array(list(frames(reference, 32, 12,
                                            extra=f"trim=start_frame={round(PREPAD * FPS)},crop=iw:ih/4:0:0")), dtype=np.float32)
    else:
        source_thumbs = np.array(list(frames(job / "source-video.mp4", 32, 12,
                                            extra=f"crop={w}:{h // 4}:{x}:{y}")), dtype=np.float32)
    rendered_thumbs = np.array(list(frames(req["renderedPath"], 32, 12,
                                          extra="crop=iw:ih/4:0:0")), dtype=np.float32)
    offset = frame_offset(source_thumbs, rendered_thumbs, round(PREPAD * FPS))
    (job / "face-registration.json").write_text(json.dumps({"fixedFrameOffset": offset}))
    patches = frames(req["renderedPath"], w, h, extra=f"trim=start={PREPAD + offset / FPS},setpts=PTS-STARTPTS")
    encoder = sp.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s",
                        f"{base['width']}x{base['height']}", "-r", str(FPS), "-i", "-", "-an", "-c:v", "libx264",
                        "-threads", "2", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                        str(job / "face-composited.mp4")], stdin=sp.PIPE)
    count = 0
    try:
        for i, frame in enumerate(frames(job / "source-video.mp4", base["width"], base["height"])):
            patch = next(patches, None)
            if patch is None or i >= len(manifest["track"]):
                raise QualityError("Missing provider/source frames", "LIPSYNC_MEDIA")
            row = np.array(manifest["track"][i])
            cx = ((row[10] + row[12]) / 2 - c["x"]) * scale_x
            cy = ((row[11] + row[13]) / 2 - c["y"]) * scale_y
            rx, ry = row[2] * scale_x * 0.42, row[3] * scale_y * 0.28
            result = blend_mouth(frame, patch, x, y, cx, cy, rx, ry)
            encoder.stdin.write(result.tobytes())
            count += 1
    finally:
        patches.close()
        encoder.stdin.close()
        if encoder.wait() != 0:
            raise QualityError("Composite encode failed", "LIPSYNC_MEDIA")
    if count < math.floor(manifest["durationSeconds"] * FPS):
        raise QualityError("Composite was truncated", "LIPSYNC_MEDIA")
    return {"frames": count, "elapsedSeconds": round(time.perf_counter() - started, 3)}


def load_syncnet():
    import torch
    from syncnet import SyncNet
    torch.set_num_threads(2)
    model = SyncNet()
    model.load_state_dict(torch.load(MODELS / "syncnet_v2.model", map_location="cpu", weights_only=True))
    model.eval()
    return model


def sync_face_crop(frame, box):
    x1, y1, x2, y2 = box
    height, width = frame.shape[:2]
    crop = frame[max(0, y1):min(height, y2), max(0, x1):min(width, x2)]
    return cv2.copyMakeBorder(crop, max(0, -y1), max(0, y2 - height),
                              max(0, -x1), max(0, x2 - width), cv2.BORDER_CONSTANT)


def sync_scores(video, audio, face_track=None, model=None):
    import torch
    import python_speech_features as psf
    if model is None:
        model = load_syncnet()
    try:
        info, data = track(video) if face_track is None else face_track
    except QualityError as error:
        raise QualityError(str(error), "LIPSYNC_ALIGNMENT") from error
    pcm = np.frombuffer(ffmpeg(["-i", str(audio), "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"]), np.int16)
    mfcc = torch.from_numpy(psf.mfcc(pcm, 16000).T.copy()).float()[None, None]
    centers = data[:, :2] + data[:, 2:4] / 2
    sizes = np.max(data[:, 2:4], axis=1) / 2
    boxes = median_filter(np.column_stack([centers, sizes]), size=(13, 1), mode="nearest")
    queue = collections.deque(maxlen=5)
    videos, audios, vf, af = [], [], [], []
    def flush():
        if videos:
            with torch.inference_mode():
                vf.append(model.forward_lip(torch.stack(videos)).numpy())
                af.append(model.forward_aud(torch.cat(audios)).numpy())
            videos.clear()
            audios.clear()
    for i, frame in enumerate(frames(video, info["width"], info["height"], fps=25)):
        cx, cy, bs = boxes[min(round(i * FPS / 25), len(boxes) - 1)]
        x1, y1, x2, y2 = map(int, (cx - bs * 1.4, cy - bs, cx + bs * 1.4, cy + bs * 1.8))
        crop = sync_face_crop(frame, (x1, y1, x2, y2))
        queue.append(cv2.resize(crop, (224, 224)))
        j = i - 4
        if j < 0 or j * 4 + 20 > mfcc.shape[-1] or (j + 5) * 640 > len(pcm):
            continue
        videos.append(torch.from_numpy(np.stack(queue)).permute(3, 0, 1, 2).float())
        audios.append(mfcc[:, :, :, j * 4:j * 4 + 20])
        if len(videos) == 4:
            flush()
    flush()
    if not vf:
        raise QualityError("Too little speech to measure alignment", "LIPSYNC_ALIGNMENT")
    v, a = np.concatenate(vf), np.concatenate(af)
    n = len(v)
    energy = np.array([np.sqrt(np.mean(pcm[i * 640:(i + 1) * 640].astype(float) ** 2)) for i in range(n)])
    threshold = max(100, np.percentile(energy, 90) * 0.08)
    rows = []
    # Overlapping windows cover the entire utterance; silence is not evidence of
    # synchronisation. Search +/-200ms at the model's 40ms temporal resolution.
    for start in range(5, n - 5, 25):
        ids = np.arange(start, min(start + 50, n - 5))
        ids = ids[energy[np.minimum(ids + 2, n - 1)] > threshold]
        if len(ids) < 12:
            continue
        distances = [float(np.linalg.norm(v[ids] - a[ids - d], axis=1).mean()) for d in range(-5, 6)]
        best = int(np.argmin(distances))
        rows.append({"startSeconds": start / 25, "endSeconds": min(start + 50, n - 5) / 25,
                     "delayMs": (best - 5) * 40, "confidence": float(np.median(distances) - distances[best])})
    return rows


def choose_delay(rows):
    # Uncertain windows are not proof of bad sync. Use a robust consensus to
    # calibrate the clip; without enough evidence, preserve its existing timing.
    delays = [r["delayMs"] for r in rows if r["confidence"] >= 3 and abs(r["delayMs"]) < 200]
    if not delays or len(delays) < len(rows) * 0.6:
        return None
    median = float(np.median(delays))
    agreeing = [d for d in delays if abs(d - median) <= 40]
    if len(agreeing) < len(delays) * 0.8:
        return None
    return float(np.median(agreeing))


def align(req):
    started = time.perf_counter()
    video, audio, output = req["videoPath"], req["audioPath"], req["outputPath"]
    report = {"version": 2, "before": [], "after": [], "warnings": []}
    info = probe(video)
    model, data = None, None
    try:
        model = load_syncnet()
        manifest_path = Path(req["jobDir"]) / "face-manifest.json"
        if manifest_path.exists():
            # Prepare already checked every native source frame. Composite
            # preserves those frames and changes only the registered mouth.
            # Reuse their positions; both complete AV measurements still run.
            manifest = json.loads(manifest_path.read_text())
            data = np.array(manifest["track"], dtype=float)
            if (manifest["version"] != 1 or data.ndim != 2 or data.shape[1] != 14 or
                    not np.all(np.isfinite(data)) or len(data) < math.floor(info["duration"] * FPS) or
                    abs(info["duration"] - manifest["durationSeconds"]) > 1 / FPS):
                raise QualityError("Validated face track does not cover the composite", "LIPSYNC_ALIGNMENT")
            data[:, 0::2] *= info["width"] / manifest["source"]["width"]
            data[:, 1::2] *= info["height"] / manifest["source"]["height"]
        else:
            info, data = track(video)
        report["before"] = sync_scores(video, audio, (info, data), model)
    except Exception as error:
        # Measurement is advisory. Actual media encoding errors below still
        # propagate; a missing model or ambiguous face must not lose a render.
        report["warnings"].append(f"Initial measurement unavailable: {error}")
        data = None
    measured_before = time.perf_counter()
    delay = choose_delay(report["before"])
    report["calibrationStatus"] = "measured" if delay is not None else "unchanged"
    if delay is None:
        report["warnings"].append("No reliable global offset; kept original timing")
        delay = 0
    # Never remove original narration to advance audio: hold the first video
    # frame instead. No speed changes, frame-by-frame time warp or spoken trim.
    video_pad, audio_pad = max(0, -delay / 1000), max(0, delay / 1000)
    target_duration = max(probe(video)["duration"] + video_pad, probe(audio)["duration"] + audio_pad)
    ffmpeg(["-i", video, "-i", audio, "-filter_complex",
            f"[0:v]setpts=PTS-STARTPTS,tpad=start_duration={video_pad}:stop_duration=0.5:start_mode=clone:stop_mode=clone[v];"
            f"[1:a]asetpts=PTS-STARTPTS,adelay={audio_pad * 1000}:all=1[a]",
            "-map", "[v]", "-map", "[a]", "-t", str(target_duration), "-c:v", "libx264", "-threads", "2",
            "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", output])
    after_info = probe(output)
    encoded = time.perf_counter()
    if (after_info["width"], after_info["height"]) != (info["width"], info["height"]):
        raise QualityError("Encoded candidate changed frame geometry", "LIPSYNC_MEDIA")
    # Encoding changes mouth pixels, not face position. Reuse the validated
    # full-clip track with the exact cloned-frame prefix; both SyncNet passes
    # still decode their own video/audio and measure every speech window.
    if data is not None:
        try:
            padded_data = np.concatenate([np.repeat(data[:1], round(video_pad * FPS), axis=0), data])
            report["after"] = sync_scores(output, output, (after_info, padded_data), model)
        except Exception as error:
            report["warnings"].append(f"Final measurement unavailable: {error}")
    residual = choose_delay(report["after"])
    report.update({"appliedDelayMs": delay, "residualDelayMs": residual})
    if residual is None or abs(residual) > 40:
        report["warnings"].append("Final sync measurement is inconclusive or locally inconsistent")
    measured_after = time.perf_counter()
    report["timingsSeconds"] = {"measureBefore": round(measured_before - started, 3),
                               "encode": round(encoded - measured_before, 3),
                               "measureAfter": round(measured_after - encoded, 3),
                               "total": round(measured_after - started, 3)}
    (Path(req["jobDir"]) / "face-sync-report.json").write_text(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    try:
        operation = sys.argv[1]
        request = json.loads(Path(sys.argv[2]).read_text())
        handlers = {"prepare": prepare, "composite": composite, "align": align,
                    "analyze": lambda r: {"segments": sync_scores(r["videoPath"], r["audioPath"])}}
        print(json.dumps(handlers[operation](request)))
    except QualityError as error:
        print(f"{error.code}: {error}", file=sys.stderr)
        sys.exit(2)
