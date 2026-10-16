# Internal cloud and browser material mixer

Cloud materials are the default in the UI when all four server-side settings are present:

```dotenv
MIX_MATERIAL_COS_SECRET_ID=
MIX_MATERIAL_COS_SECRET_KEY=
MIX_MATERIAL_COS_BUCKET=hunjianx-1410143389
MIX_MATERIAL_COS_REGION=ap-singapore
```

These are separate from restaurant/digital-human `COS_*` and remix `MIX_AUDIO_COS_*` settings. Local development reads the ignored root `.env.local`; production reads deployment environment variables only. Set `MIX_PYTHON_BIN` to the installed Python environment in local development. The existing Python requirements already include the COS SDK and FAISS; Docker installs them automatically.

With `CREDITS_BILLING_MODE=api_cost`, remixing uses the shared account wallet at 125 points/CNY. Both first-time material analysis and generation calls are metered. OpenLux charges are reconciled against the exact request ID in its token logs (or its returned embedding quota), including the actual auto-routed group. 302 reranking and IndexTTS charges require the matching `/dashboard/api-record` receipt. API keys must permit those read-only billing queries. Quotes are temporary safety holds; neither token estimates nor an account-wide balance difference is used as a final charge. Confirmed API expenses remain charged even if the video later fails. Unlimited accounts keep receipts without deductions.

The private Node/Python bridge automatically enables metering; no browser switch or additional vector database setting is needed. Preserve `DATA_DIR/cost-calls` together with the owner map and SQLite state. Paid responses and ledger IDs are persisted before proceeding, so restarts reuse the same response/task. Unknown POST outcomes or missing exact bills block completion instead of dispatching again. Known rejected, unbilled embedding requests may retry another auto-route. Existing duration-priced jobs retain their original rule.

Customers upload supported videos directly to private COS using one-hour signed PUT tickets bound to the expected content length. Finalization checks object size and copies staging to a private immutable source key before queuing analysis. Source types: MP4, MOV, MKV, AVI, M4V, MTS, M2TS and WebM; maximum 5 GiB per file. The browser uploads at most three files concurrently; interrupted uploads can be selected again, and expired staging objects are cleaned. Configure the application's exact HTTPS origin before enabling browser uploads:

```powershell
node scripts/configure-mix-materials-cors.mjs --origin https://your-app.example
```

The script uses the four server settings above, also accepts production `AUTH_PUBLIC_URL`, and preserves existing unrelated CORS rules. HTTP origins are permitted only for localhost development. CORS permits the browser request; expiring signatures and account authorization still control object access.

The authenticated `/api/mix/materials` API lists the account's durable assets. `/uploads` creates a ticket; `/{id}/complete` queues indexing, `/{id}/retry` retries failed indexing, DELETE `/{id}` removes owned material, and GET/HEAD `/{id}/stream` returns an expiring private preview link. Processing states persist as `uploading`, `queued`, `indexing`, `ready`, `failed` or `deleting`. Completed uploads continue analysis after the browser closes. Failed descriptions reuse successful embeddings, and completed clips survive retries. New cloud jobs use `source:"cloud"` and omit `device_id`; browser-mode jobs retain the existing contract. Deleting material is blocked while the owner's cloud jobs are active, including concurrent resume requests.

Originals and analysis proxies live in COS. SQLite metadata and canonical vectors live under `DATA_DIR/cloud-materials/materials.sqlite3`; replaceable per-account FAISS snapshots live in `cloud-materials/indexes/<owner>/vectors.faiss`. Original videos are fetched to a shared checksum-validated cache when needed; idle cached payloads expire after 24 hours, while active jobs and indexing keep their inputs. Preserve the existing persistent data mount and back up its databases. This is a single active application instance design; do not run multiple independent writers against its SQLite/FAISS directories. FAISS is a search index, not an ownership database.

Deploy the renderer in Tencent Cloud Singapore alongside this bucket and use the normal COS endpoint to obtain same-region intranet routing. Tests run from a developer machine confirm COS functionality, not the production server's actual network route. Final job outputs retain the existing authenticated delivery and 72-hour retention policy. Existing browser material catalogs remain supported when cloud storage is not configured; their local originals must be uploaded to populate a new cloud library.

Node starts `python -m uvicorn app:create_app --factory --host 127.0.0.1 --port <port>` from this directory. `DATA_DIR` points to persistent storage; `MIXER_API_TOKEN` is a random ASCII service secret (at least 32 characters). Every route requires its Bearer token. Browser-material and job routes additionally require Node's verified `x-material-owner` account hash. Body-supplied identities, helper devices, and global NAS material paths are rejected.

Required server configuration: `OPENLUX_API_KEY` for embedding/vision, `RERANK_API_KEY` for reranking, and `MIX_FAL_KEY` for new synthesized narration. New jobs use `fal-ai/qwen-3-tts/text-to-speech/1.7b`, Chinese, with built-in `Vivian` voice (`MIX_FAL_VOICE` can select another supported Qwen voice). No default reference audio is required. Selecting an uploaded voice downloads the owned, hash-checked COS audio, trims it to 15 seconds, and calls `fal-ai/qwen-3-tts/clone-voice/1.7b`; reference audio and cached embeddings are sent inline. Original-audio mode needs no TTS key. Optional model overrides remain `EMBEDDING_URL`, `LLM_URL`, `RERANK_URL`. Historical jobs without a saved fal provider retain their IndexTTS configuration and checkpoints (`INDEXTTS_302_API_KEY`, `INDEXTTS_SPEAKER_AUDIO_URL` and emotion settings). Install FFmpeg/FFprobe with libass and CJK fonts. `/health` reports missing configuration; indexing is available independently of rerank/narration readiness.

The original matching/rendering engine retains saved vector recall, rerank and visual verdicts. The thin `app.py` adapter adds ownership, authenticated output streaming and retention. New `fal_voice` jobs persist queue receipts before polling and cache clone embeddings and completed scene audio; the private Node cost journal recovers metered replies without a second paid POST. Restarting marks running jobs interrupted, never automatically resubmitting them. An unmetered uncertain submission without a task ID requires manual provider reconciliation. Historical `voice` (IndexTTS) jobs retain their original resume behavior.

`POST /v1/mix/jobs` accepts `{text,device_id,ratio,quality,subtitles,music,count,duration}` and an ASCII `Idempotency-Key` of 1–128 letters, digits, underscores, or hyphens. Ratios: `9:16`, `16:9`, `1:1`; quality: `720p`, `1080p`. This version requires `count=1`, `music=false`, `duration=null`: full text is preserved and actual narration determines duration. Unsupported values produce HTTP 400. `subtitles=false` disables burn-in while retaining downloadable SRT. List/detail return `{jobs:[...]}` / `{id,state,logs,error,...}` with `/api/mix/jobs/<id>/video` after file-bound quality checks pass. Plan downloads expose only public script/timeline fields.

Browser whole files are bounded to 512 MiB, chunks to 4 MiB, with SHA256 checks, per-device/global quotas, and 24-hour whole-file cleanup. Output folders expire after 72 hours; task records expire after 30 days. Catalog vectors/descriptions persist. The service does not require COS for output delivery. Production route exposure is limited to health, browser materials, jobs, resume, and authenticated video/plan/captions.

Tests: `python -m unittest discover -s tests/mix-python` from repository root (`httpx` and Pillow are test dependencies). Tests preserve the source engine coverage and use real FFmpeg for browser frame validation, source range extraction, transfer/resume, rendering, narration duration, dimensions, color, and quality gating; only billed provider boundaries use substitutes.
