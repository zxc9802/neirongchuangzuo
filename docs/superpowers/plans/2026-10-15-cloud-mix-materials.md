# Cloud mix material implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for isolated implementation and review tasks. Do not change unrelated files or commit credentials.

**Goal:** Upload AI remix materials to private COS, persist account-scoped FAISS retrieval, and run jobs without a connected source browser.

**Architecture:** Private staging uploads are finalized to immutable COS sources. SQLite stores owned assets, resumable clips and vectors; per-account FAISS snapshots serve retrieval. The existing matching, rendering and credits pipeline consumes a cloud catalog adapter.

**Tech Stack:** Existing Node authentication gateway, FastAPI, cos-python-sdk-v5, SQLite, faiss-cpu, FFmpeg, browser JavaScript.

## Task 1: storage and durable indexing

- [x] Verify the supplied bucket with a private temporary object and delete it.
- [x] Add `tests/mix-python/test_cloud_materials.py` before implementation. Cover unknown/other owners, configured names, staging size checks, immutable finalized sources, index recovery, cache validation, deletion and FAISS isolation.
- [x] Run `.data/mix-test-venv/Scripts/python.exe -m unittest discover -s tests/mix-python -p test_cloud_materials.py -v`; confirm missing behavior fails.
- [x] Implement `services/mix/python/cloud_materials.py`, `cloud_catalog.py`, `cloud_material_routes.py`. Reuse existing provider and FFmpeg utilities; keep credentials server-side. Restore interrupted indexing to queued on application startup.
- [x] Verify the focused Python tests pass with real FFmpeg and FAISS and a fake COS boundary.

## Task 2: gateway and generation integration

- [x] Extend routing/config and regression tests in `services/mix/server.mjs`, `services/runtime-settings.mjs`, `tests/mix-routing.test.mjs`, `tests/mix-config.test.mjs` and Python application tests.
- [x] Attach cloud routes/worker in `services/mix/python/app.py`; accept `source: "cloud"` without browser device IDs, retain legacy specs, enforce account ownership and active-job deletion lock. Add cloud catalog dispatch to `matcher.py` and hydration to `remote_catalog.py`.
- [x] Add `MIX_MATERIAL_COS_*` placeholders to `.env.example` and redact those keys in provider errors. Actual local configuration stays in ignored `.env.local`.
- [x] Run `node --test tests/mix-routing.test.mjs tests/mix-config.test.mjs` and the Python remix suite.

## Task 3: cloud materials page

- [x] Add `design/cloud-materials.js` and behavior tests in `tests/cloud-materials.test.mjs`. API contract: GET `/api/mix/materials` -> `{configured,items,indexed_clips}`; item fields `id,name,bytes,duration,state,error,indexed_clips,url`; POST `/uploads` `{name,bytes}` -> `{id,upload_url,headers}`; POST `/{id}/complete` and `/{id}/retry` -> `{item}`; DELETE `/{id}` -> `{ok:true}`.
- [x] Upload only to the signed HTTPS COS bucket hostname, without site credentials. Poll persistent processing state, cancel on account change, and restore metadata from the server. Bound folder upload concurrency to three.
- [x] Update `design/mix-materials.js`, `design/studios.js` and `preview.mjs` to select cloud mode when `health.material_library.configured` is true. Cloud job body includes `source:"cloud"` and omits `device_id`. Cloud readiness uses server indexed clips; no local directory permissions or page-online instructions.
- [x] Run the new frontend tests plus existing mix browser/UI tests.

## Task 4: acceptance

- [x] Configure an additive bucket CORS rule for this application's known origins and verify real preflight/PUT.
- [x] Run a small real video through upload finalization, indexing, FAISS search and cache hydration; verify no browser dependence and clean up test-owned cloud assets.
- [x] Run syntax checks and the full relevant Python/Node remix suites, inspect the final diff for credentials and unrelated modifications, and document production environment and persistent storage requirements in `services/mix/python/README.md`.

## Acceptance evidence

- Node remix/cloud suites: 156 passed. Python remix suites: 211 passed. Syntax and git diff whitespace checks passed. Final spec and code quality reviews have no remaining important findings.
- Private COS read/write/delete and unauthenticated 403 verified against the supplied Singapore bucket.
- Real signed direct PUT and CORS preflight passed; signed wrong-length PUT returned 403.
- Actual embedding/description, FAISS recall, reranking, cache-eviction original download and rendering passed.
- Full Node gateway -> Python service -> background index -> cloud job -> render -> Gemini quality gate -> video download passed. Evidence: `.data/mix-http-acceptance/53baa101-676a-4916-a541-da694b9d126e/report.json`. Test-owned originals/proxies were deleted.
- Current bucket CORS origins are local preview origins only. Production deployment must set the four MIX_MATERIAL_COS variables, preserve DATA_DIR, and run the CORS command for its actual HTTPS origin. No production server deployment or intranet-route verification was performed.
