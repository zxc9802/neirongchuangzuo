# VEED face workflow

New VEED video tasks use the source-resolution face workflow. All video
providers and recovered video tasks use advisory timing calibration.
MP3-only tasks are unchanged. There is no automatic paid regeneration.

1. Prepare the full-frame 30 fps base as before. Independently track the face in
   the original, autorotated source; crop before reducing resolution. Reject
   missing/multiple faces, cuts and insufficient native resolution before a
   provider job is submitted.
2. Use one stable square crop containing the tracked face. Prepend 0.6 seconds
   of cloned video/silent PCM and append 0.3 seconds. Narration samples and speed
   are preserved. Store native crop coordinates, per-frame mouth positions and
   frame timing in `face-manifest.json`.
3. Send the prepared face crop and padded audio through the existing VEED
   adapter. Keep the full-frame base, original voice and manifest in job storage
   and private COS before paid submission so recovery can reconstruct the frame.
4. Compare background motion to establish one fixed frame offset. Remove the
   leading context and composite a feathered mouth region into the original
   frame. Reject unstable frame correspondence; never retime individual frames.
5. Measure AV alignment in overlapping speech windows using SyncNet. Use the
   median reliable offset when at least 60% of windows are measurable and 80%
   of those agree within 40 ms. Move audio or pad the video start; original speech
   is never trimmed or accelerated. Measure the encoded candidate again for the
   private report. Uncertain scores never prevent delivery. If calibration is
   unavailable or inconsistent, retain the existing timing and complete audio.
   Actual decoding, compositing and encoding failures still require recovery.

The score is an engineering check, not a guarantee of perceptual quality. It
requires at least 1.2 seconds of narration and has 40 ms temporal resolution,
a +/-200 ms search range and a confidence floor
of 3. Confidence is used to select calibration evidence, not to reject a clip.
The 63-second regression had one ambiguous window but a stable 40 ms offset;
the former all-windows gate incorrectly rejected the entire video.
larger poses, occlusion, different voices and long/chunked clips need further
acceptance footage. Existing 90-second provider chunking is unchanged; padding
is applied to the utterance, not separately to every provider chunk.

## Runtime

Production Docker installs CPU PyTorch 2.6.0, the pinned Python requirements and
checksum-verified model files. No model download occurs in a user task. Worker
invocations are serialized within a Node server process and stream frames to
bound memory. Python subprocesses have a 30-minute timeout.

For a local environment with Python 3.11/3.12 and FFmpeg:

```sh
python3 -m venv .runtime/lipsync
.runtime/lipsync/bin/pip install torch==2.6.0 -r scripts/face-lipsync/requirements.txt
.runtime/lipsync/bin/python scripts/face-lipsync/download_models.py .runtime/lipsync-models
export LIPSYNC_PYTHON="$PWD/.runtime/lipsync/bin/python"
export LIPSYNC_MODEL_DIR="$PWD/.runtime/lipsync-models"
```

On Linux, install the CPU-specific wheel using the same command as the
Dockerfile to avoid pulling GPU dependencies. A missing runtime fails before
paid submission; there is no silent fallback to full-frame VEED input.

## Checks

```sh
npm test
npm run build
"$LIPSYNC_PYTHON" scripts/face-lipsync/test_worker.py
```

`tests/pipeline-billing-runtime.test.mjs` checks that the actual pipeline uses
the original source for preparation, submits transformed inputs and finalizes
through compositing/alignment and preserves billing on actual media failures.
`tests/bug-regressions.test.mjs` checks padded-duration recovery, the shared
finalizer and preservation of existing provider work without resubmission.
Python checks cover native crop bounds, rejection of low-resolution input,
sample-exact PCM padding, robust offsets and non-blocking uncertainty.

To measure a private video without sending it to a provider, save a JSON file
with absolute `videoPath` and `audioPath` fields (both may point to the video),
then run `worker.py analyze /absolute/path/request.json`. The `align` operation
additionally accepts `jobDir` and `outputPath`. Reports are saved privately as
`face-sync-report.json`; user-facing errors omit technical provider details.

Model attribution and licenses are in [NOTICE.md](NOTICE.md).

