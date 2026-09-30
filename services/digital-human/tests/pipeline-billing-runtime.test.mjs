import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";
import * as billing from "../src/lib/main-app-billing.ts";
import * as media from "../src/lib/engine/ffmpeg.ts";
import * as safeLog from "../src/lib/server/safe-log.ts";
import * as taskExecution from "../src/lib/engine/task-execution.ts";
import { isTaskOutputDeliverable } from "../src/lib/server/public-data.ts";

const source = fs.readFileSync(new URL("../src/lib/engine/pipeline.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
}}).outputText;

test("pipeline checks real duration before paid lipsync, preserves refunds and successful billing", async () => {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.MAIN_APP_SSO_CLIENT_SECRET;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-billing-test-"));
  process.chdir(tmp);
  process.env.MAIN_APP_SSO_CLIENT_SECRET = "test-only-secret";
  try {
    const silent = path.join(tmp, "silent.mp4");
    const sound = path.join(tmp, "sound.mp4");
    const speaker = path.join(tmp, "speaker.wav");
    fs.writeFileSync(speaker, "fixture");
    for (const args of [
      ["-f", "lavfi", "-i", "color=c=black:s=160x120:r=30", "-t", "6", "-c:v", "libx264", silent],
      ["-i", silent, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100", "-t", "6", "-c:v", "copy", "-c:a", "aac", sound],
    ]) {
      const generated = spawnSync("ffmpeg", ["-v", "error", ...args], {encoding: "utf8"});
      assert.equal(generated.status, 0, generated.stderr);
    }
    for (const scenario of ["under-reserved", "silent-smart", "external-success", "internal-success", "settle-outage", "preserve-failure", "setup-failure", "audio-only", "audio-under-reserved", "audio-settle-outage"]) {
      const audioOnly = scenario.startsWith("audio-");
      const events = [];
      globalThis.fetch = async (url, init) => {
        assert.ok(String(url).endsWith("/api/sso/billing"), "no real network calls");
        const request = JSON.parse(init.body);
        events.push({stage: "ledger", action: request.action, points: request.points});
        if (scenario.endsWith("settle-outage") && request.action === "settle") throw new Error("simulated timeout");
        return Response.json({success: true, data: {reservedCredits: request.points,
          requestId: request.requestId, chargeRequired: true, pointsBalance: 940}});
      };
      const user = {id: "owner", role: scenario === "internal-success" ? "admin" : "member"};
      const reservation = await billing.reserveMainAppCredits({user, sessionToken: "fake", estimatedDuration: 6});
      const duration = scenario.endsWith("under-reserved") ? 8 : 3;
      let task = {id: scenario, userId: user.id, status: "pending", logs: [],
        billing: {isExternalUser: reservation.chargeRequired, status: reservation.chargeRequired ? "reserved" : "not_applicable",
          requestId: reservation.requestId, estimatedDuration: 6, estimatedPoints: reservation.requiredPoints, reservedPoints: reservation.reservedPoints},
        inputs: {videoPath: audioOnly ? "" : scenario === "silent-smart" ? silent : sound, videoUrl: "", outputType: audioOnly ? "audio" : "video", scriptText: "你好",
          speakerAudioUrl: speaker, videoFit: scenario === "preserve-failure" ? "preserve" : "smart", lipsyncProvider: "veed"}, results: {}};
      const TaskStore = {get: () => task, isDeleted: () => false,
        addLog: (_id, message, level, publicMessage) => task.logs.push({message, level, publicMessage}),
        update: (_id, update) => {task = {...task, ...update, results: {...task.results, ...update.results}}; return task;}};
      const deps = {
        path, fs, crypto, "../server/safe-log": safeLog, "./task-execution": taskExecution,
        "../store/task-store": {TaskStore},
        "../config": {getAppConfig: () => ({storageDir: path.join(tmp, "jobs"), publicBaseUrl: "https://media.example.test", indexttsSpeakerAudioUrl: speaker})},
        "./indextts": {generateIndexTTS: async (_text, options) => {
          events.push({stage: "tts"});
          const wav = path.join(options.outDir, "voice-track.wav"); fs.writeFileSync(wav, "fixture");
          if (audioOnly) {
            const generated = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", String(duration), wav], {encoding: "utf8"});
            assert.equal(generated.status, 0, generated.stderr);
          }
          return {finalWavPath: wav, rawDuration: duration, selectedDuration: duration};
        }},
        "./ffmpeg": {...media, finalizeVideo: async (_video, _audio, output) => {
          fs.writeFileSync(output, "fixture"); return {durationSeconds: duration, width: 160, height: 120, fps: 30};
        }},
        "../mcp/heygen-adapter": {HeyGenMcpAdapter: {}},
        "./openlux-lipsync": {OpenLuxLipsyncAdapter: {}},
        "./fal-veed-lipsync": {FalVeedLipsyncAdapter: {execute: async options => {
          events.push({stage: "lipsync"}); options.onProviderAccepted();
          options.onJobCreated({lipsyncId: "test-job"});
          return {lipsyncId: "test-job", status: "completed"};
        }}},
        "../cos": {CosService: {isConfigured: () => false}},
        "../lipsync-provider": {resolveLipsyncProvider: () => "veed"},
        "../media-path-policy": {resolveAllowedLocalMediaPath: value => value},
        "../server/media-response": {getTrustedExternalMediaUrl: async () => {throw new Error("local fixture");}},
        "../main-app-billing": billing,
      };
      if (scenario === "setup-failure") {
        deps.fs = {...fs, mkdirSync: (target, options) => {
          if (target === path.join(tmp, "jobs", scenario)) throw Object.assign(new Error("simulated disk full"), {code: "ENOSPC"});
          return fs.mkdirSync(target, options);
        }};
      }
      const module = {exports: {}};
      new Function("require", "module", "exports", compiled)(name => {
        assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name];
      }, module, module.exports);
      await module.exports.runDigitalHumanPipeline(scenario, "fake");
      if (audioOnly) assert.equal(events.some(e => e.stage === "lipsync"), false, "audio must never submit paid lip-sync");
      if (scenario.endsWith("under-reserved") || scenario === "preserve-failure" || scenario === "setup-failure") {
        assert.equal(events.some(e => e.stage === "lipsync"), false, scenario);
        assert.equal(task.status, "failed", scenario);
        assert.equal(task.billing.status, "released", scenario);
        assert.equal(isTaskOutputDeliverable(task), false, scenario);
        if (scenario.endsWith("under-reserved")) assert.equal(task.errorCode, "BILLING_RESERVATION_TOO_SMALL");
        if (scenario === "setup-failure") assert.equal(events.some(e => e.stage === "tts"), false);
      } else if (scenario.endsWith("settle-outage")) {
        assert.equal(task.billing.status, "settle_pending");
        assert.equal(events.some(e => e.action === "release"), false);
        assert.equal(isTaskOutputDeliverable(task), false);
      } else {
        assert.equal(task.status, "completed", `${scenario}: ${task.error}`);
        assert.equal(isTaskOutputDeliverable(task), true);
        assert.equal(events.filter(e => e.action === "settle").length, scenario === "internal-success" ? 0 : 1);
        if (audioOnly) {
          assert.equal(task.results.finalVideoUrl, undefined);
          assert.equal(task.results.audioFormat, "mp3");
          assert.match(task.results.exactAudioUrl, /voice-track\.mp3$/);
          const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", task.results.exactAudioUrl], {encoding: "utf8"});
          const streams = JSON.parse(probe.stdout).streams;
          assert.equal(streams.length, 1);
          assert.equal(streams[0].codec_type, "audio");
          assert.equal(streams[0].codec_name, "mp3");
        }
      }
    }
  } finally {
    process.chdir(originalCwd); globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.MAIN_APP_SSO_CLIENT_SECRET;
    else process.env.MAIN_APP_SSO_CLIENT_SECRET = originalSecret;
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});
