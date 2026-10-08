# Parallel material index implementation plan

**Goal:** Complete the approved concurrent indexing and deferred source repair without reindexing unchanged clips or modifying source media.

**Architecture:** Three browser workers perform metadata/frame/model work; a single coordinator maintains heartbeats and prioritizes fresh clips. Browser FFmpeg repairs failed sources after normal work. The Python broker computes vector and description in parallel and persists each successful half for retries.

**Tech stack:** ES modules, Web Workers, IndexedDB, pinned ffmpeg.wasm, Python concurrent.futures, existing SQLite/FastAPI.

- [x] Browser scheduling: gated-promise tests first failed, then passed after implementing three workers, fresh/retry queues and cancellation. A concurrent upload-progress regression was also reproduced and fixed.
- [x] Backend analysis: barrier/event tests first failed, then passed with independent model futures and partial-result persistence. Broker/adapter: 42 tests passed. Read-only spec and code reviews approved.
- [x] Local repair: deferred oversize/MOV recovery, unchanged source identity, cached copy reuse, cancellation and pinned vendor routes covered. Same-origin FFmpeg worker and account-scoped IndexedDB cache implemented.
- [x] Real WASM core and real browser verified generated MOV conversion, H264/AAC, rotation, complete duration/audio, unchanged source checksum and cancellation. A 513 MiB padded video Blob passed the real WORKERFS path; this is not a long-video performance benchmark. Browser demonstrated three simultaneous frame readers and three model requests with a test provider. Evidence: ignored `outputs/index-repair-20261008/`. Documented browser limits and local-only delivery; no production deployment.
