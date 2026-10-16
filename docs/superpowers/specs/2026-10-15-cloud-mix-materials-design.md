# Cloud material library for AI remix

The user approved server-side remixing with Tencent COS and a FAISS index. The supplied material bucket is `hunjianx-1410143389`, region `ap-singapore`; production compute is also Tencent Cloud Singapore. Credentials belong only in ignored server configuration or deployment environment variables.

Use COS for original videos and generated analysis proxies. Keep account ownership, processing state, clip descriptions and authoritative vectors in SQLite under the existing persistent mix data directory. Build one replaceable FAISS snapshot per account from those vectors. This retains the current single-service deployment; SQLite and FAISS require the persistent data mount and are not a distributed multi-writer database.

Customers select a folder and upload supported videos directly to private COS using short-lived signed PUT URLs. Finalization verifies object size and copies the upload to an immutable source key before queuing server-side indexing. Indexing and subsequent jobs continue without the browser. Signed upload URLs authorize only temporary staging objects. Existing browser-local materials remain available when cloud storage is not configured.

Expose authenticated `/api/mix/materials` listing, `/uploads` creation, `/{id}/complete`, `/{id}/retry`, deletion and GET/HEAD `/{id}/stream`. Node derives the owner from the existing login; client-supplied ownership and object keys are never accepted. Public metadata excludes storage keys and credentials. Cloud jobs submit `source: "cloud"`; the server validates that the owner's cloud library has ready indexed clips. Prevent deletion while the owner's cloud jobs are active.

Keep existing embedding, description, reranking, narration, rendering, quality and credits behavior. Split uploaded videos into eight-second analysis clips. Persist each successful clip independently so retries avoid repeating completed model calls. Fetch only selected original videos into a shared server cache for rendering; render against original source times. Preview uses expiring private COS links through authenticated routes.

Verification: real COS private upload/read/delete probe; account isolation and signed upload immutability; durable queue/retry and FAISS reload; original source/cache hydration; cloud job authorization and browser-independent execution; frontend account-change cancellation and persistence; existing Node/Python remix suites; a small real video upload/index/search/render smoke test where provider configuration permits.
