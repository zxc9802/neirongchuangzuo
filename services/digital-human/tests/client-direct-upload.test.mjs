import assert from "node:assert/strict";
import test from "node:test";
import { uploadMediaFile } from "../src/lib/client-media-upload.ts";

test("browser sends file slices to storage, retries a failed slice and confirms before reporting success", async () => {
  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  const requests = [];
  const controls = [];
  const progress = [];
  const size = 2.5 * 1024 * 1024;
  const parts = [1024 * 1024, 1024 * 1024, 512 * 1024].map((size, i) => ({ size, url: `https://storage.example.test/part-${i}` }));
  let failedPart = false;
  let confirms = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    controls.push({ url, body });
    if (String(url).endsWith("/direct")) return Response.json({ direct: true, uploadKey: "owned-key", parts });
    if (++confirms === 1) return Response.json({ error: "暂时无法确认" }, { status: 503 });
    return Response.json({ success: true, uploadKey: "owned-key", storedRemotely: true });
  };
  globalThis.XMLHttpRequest = class {
    upload = {};
    headers = {};
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    send(blob) {
      requests.push({ method: this.method, url: this.url, size: blob.size, headers: this.headers });
      queueMicrotask(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: blob.size, total: blob.size });
        if (this.url === parts[1].url && !failedPart) { failedPart = true; this.onerror(); return; }
        this.status = this.url.startsWith("https://storage.") ? 200 : 413;
        this.responseText = "";
        this.onload();
      });
    }
  };
  try {
    const result = await uploadMediaFile(new Blob([Buffer.alloc(size)], { type: "video/mp4" }), "黄总.mp4", "videos", p => progress.push(p));
    assert.deepEqual(result, { uploadKey: "owned-key", storedRemotely: true });
    assert.deepEqual(parts.map(part => requests.filter(r => r.url === part.url).length), [1, 2, 1]);
    assert.ok(requests.every(r => r.method === "PUT" && !Object.hasOwn(r.headers, "Content-Length")));
    assert.deepEqual(requests.map(r => r.size).sort((a, b) => a - b), [524288, 1048576, 1048576, 1048576]);
    assert.equal(controls[0].body.fileSize, size);
    assert.ok(controls.every(r => JSON.stringify(r.body).length < 512));
    assert.equal(confirms, 2);
    assert.equal(progress.at(-1), 100);
    assert.ok(progress.slice(0, -1).every(p => p < 100), "100% requires final confirmation");
    assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]), "Retry progress must not go backwards");
  } finally { globalThis.fetch = originalFetch; globalThis.XMLHttpRequest = originalXhr; }
});


test("denied direct parts stop without falling back to a whole-file server upload", async () => {
  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  const calls = [];
  globalThis.fetch = async () => Response.json({ direct: true, uploadKey: "owned", parts: [{ url: "https://storage.example.test/part", size: 4 }] });
  globalThis.XMLHttpRequest = class {
    upload = {};
    open(method, url) { calls.push({ method, url }); }
    setRequestHeader() {}
    send() { this.status = 403; queueMicrotask(() => this.onload()); }
  };
  try {
    await assert.rejects(uploadMediaFile(new Blob(["data"], {type:"video/mp4"}), "video.mp4"), /403/);
    assert.deepEqual(calls, [{method:"PUT", url:"https://storage.example.test/part"}]);
  } finally { globalThis.fetch = originalFetch; globalThis.XMLHttpRequest = originalXhr; }
});

test("installations without COS keep their existing local upload behavior", async () => {
  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  const file = new Blob(["video"], {type:"video/mp4"});
  let sent;
  globalThis.fetch = async () => Response.json({direct:false});
  globalThis.XMLHttpRequest = class {
    upload = {};
    open(method, url) { assert.equal(method, "POST"); assert.match(url, /^\/api\/upload\?/); }
    setRequestHeader() {}
    send(body) {
      sent = body; this.status = 200;
      this.responseText = JSON.stringify({success:true, uploadKey:"local-key", storedRemotely:false});
      queueMicrotask(() => this.onload());
    }
  };
  try {
    assert.deepEqual(await uploadMediaFile(file, "video.mp4"), {uploadKey:"local-key", storedRemotely:false});
    assert.equal(sent, file);
  } finally { globalThis.fetch = originalFetch; globalThis.XMLHttpRequest = originalXhr; }
});

test('local upload shows the server explanation instead of only an HTTP status',async()=>{
  const originalFetch=globalThis.fetch,originalXhr=globalThis.XMLHttpRequest;
  globalThis.fetch=async()=>Response.json({direct:false});
  globalThis.XMLHttpRequest=class{
    upload={};open(){}setRequestHeader(){}
    send(){this.status=400;this.responseText=JSON.stringify({error:'上传未完成，请重新上传'});queueMicrotask(()=>this.onload());}
  };
  try{await assert.rejects(uploadMediaFile(new Blob(['video'],{type:'video/mp4'}),'video.mp4'),/^Error: 上传未完成，请重新上传$/);}
  finally{globalThis.fetch=originalFetch;globalThis.XMLHttpRequest=originalXhr;}
});


test("uploads at most three parts concurrently, refills free slots and preserves byte order and aggregate progress", async () => {
  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  const parts = [4, 4, 4, 4, 1].map((size, i) => ({size, url:`https://storage.example.test/part-${i}`}));
  const requests = [];
  const progress = [];
  const source = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  let active = 0;
  let maxActive = 0;
  let confirm;
  let running;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  globalThis.fetch = async url => {
    if (String(url).endsWith("/direct")) return Response.json({direct:true, uploadKey:"owned", parts});
    assert.equal(requests.filter(r => r.finished).length, 5, "Confirmation must wait for every part");
    return new Promise(resolve => {confirm = () => resolve(Response.json({success:true, uploadKey:"owned"}));});
  };
  globalThis.XMLHttpRequest = class {
    upload = {};
    open(method, url) {this.url = url;}
    setRequestHeader() {}
    send(blob) {this.blob = blob; requests.push(this); maxActive = Math.max(maxActive, ++active);}
    respond(status = 200) {if (this.finished) return; this.finished = true; active--; this.status = status; this.onload();}
  };
  try {
    running = uploadMediaFile(new Blob([source], {type:"video/mp4"}), "video.mp4", "videos", p => progress.push(p));
    running.catch(() => {});
    await tick();
    assert.equal(requests.length, 3, "The first three parts should start without waiting for a response");
    requests[0].upload.onprogress({lengthComputable:true, loaded:1});
    requests[1].upload.onprogress({lengthComputable:true, loaded:1});
    requests[2].upload.onprogress({lengthComputable:true, loaded:2});
    assert.equal(progress.at(-1), 24, "Progress sums bytes across active parts");
    requests[1].respond();
    await tick();
    assert.equal(requests.length, 4, "A free slot starts the next part while slower parts continue");
    requests[3].respond();
    await tick();
    assert.equal(requests.length, 5);
    requests[4].respond();
    requests[2].respond();
    await tick();
    assert.equal(confirm, undefined);
    requests[0].respond();
    await tick();
    assert.ok(progress.every(p => p < 100));
    assert.equal(maxActive, 3);
    assert.equal(progress.at(-1), 99);
    assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]));
    const uploaded = await Promise.all(requests.map(async r => Buffer.from(await r.blob.arrayBuffer())));
    assert.deepEqual(Buffer.concat(uploaded), Buffer.from(source));
    confirm();
    assert.deepEqual(await running, {uploadKey:"owned", storedRemotely:true});
    assert.equal(progress.at(-1), 100);
  } finally {
    requests.forEach(r => r.respond(403));
    confirm?.();
    await running?.catch(() => {});
    globalThis.fetch = originalFetch; globalThis.XMLHttpRequest = originalXhr;
  }
});


test("a terminal part failure aborts active parts and prevents queued uploads and delayed retries", async () => {
  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  const parts = Array.from({length:6}, (_, i) => ({size:4, url:`https://storage.example.test/part-${i}`}));
  const requests = [];
  const progress = [];
  let confirms = 0;
  let running;
  globalThis.fetch = async url => {
    if (String(url).endsWith("/direct")) return Response.json({direct:true, uploadKey:"owned", parts});
    confirms++;
    return Response.json({success:true, uploadKey:"owned"});
  };
  globalThis.XMLHttpRequest = class {
    upload = {};
    open(method, url) {this.url = url;}
    setRequestHeader() {}
    send() {requests.push(this);}
    fail(status) {if (this.finished) return; this.finished = true; this.status = status; status ? this.onload() : this.onerror();}
    abort() {this.aborted = true; this.finished = true; this.onabort?.();}
  };
  try {
    running = uploadMediaFile(new Blob([new Uint8Array(24)], {type:"video/mp4"}), "video.mp4", "videos", p => progress.push(p));
    running.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 3);
    requests[0].upload.onprogress({lengthComputable:true, loaded:3});
    requests[0].fail(0); // This part is now waiting to retry.
    await new Promise(resolve => setImmediate(resolve));
    requests[1].fail(403);
    await assert.rejects(running, /403/);
    assert.equal(requests[2].aborted, true, "Other in-flight requests must stop on a terminal failure");
    const updates = progress.length;
    requests[2].upload.onprogress({lengthComputable:true, loaded:4});
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(requests.length, 3, "The sleeping retry and queued parts must not start");
    assert.equal(progress.length, updates, "Cancelled transfers cannot update progress");
    assert.equal(confirms, 0);
    assert.ok(progress.every(p => p < 100));
  } finally {
    await new Promise(resolve => setTimeout(resolve, 550));
    requests.forEach(r => r.fail(403));
    await running?.catch(() => {});
    globalThis.fetch = originalFetch; globalThis.XMLHttpRequest = originalXhr;
  }
});
