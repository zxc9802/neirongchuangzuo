import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { prepareSceneContinuation, selectContinuationShots } from "../src/lib/engine/scene-tail.ts";
import { probeMedia } from "../src/lib/engine/ffmpeg.ts";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

test("selection prefers a matching quiet section over a repeated large gesture", () => {
  const samples = [10,240,10,240,10,240,90,91,90,91,90,91,90,91,90,91];
  const shots = selectContinuationShots(samples.map(x => Uint8Array.of(x)), 2, 8, 2);
  assert.equal(shots.length, 1);
  assert.ok(shots[0].startSeconds >= 3);
  assert.ok(shots[0].startSeconds + shots[0].durationSeconds <= 8);
  assert.equal(shots[0].durationSeconds, 2);
});

test("long narration receives moving footage from the same source before lip-sync", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "scene-tail-test-"));
  try {
    const input = path.join(folder, "input.mp4"), output = path.join(folder, "extended.mp4");
    run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x240:r=15:d=4",
      "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=44100", "-t", "4", "-c:v", "libx264", "-c:a", "aac", input]);
    const original = fs.readFileSync(input);
    const messages = [];
    assert.equal(await prepareSceneContinuation({ inputPath: input, targetSeconds: 6.27,
      outputPath: output, onLog: message => messages.push(message) }), output);
    const probe = await probeMedia(output);
    assert.equal(probe.width, 160);
    assert.equal(probe.height, 240);
    assert.equal(probe.fps, 30);
    assert.ok(Math.abs(probe.durationSeconds - 6.3) < 0.01);
    assert.equal(probe.hasAudio, false, "reused source speech must not be mixed into the new narration");
    assert.deepEqual(fs.readFileSync(input), original);
    const plan = JSON.parse(fs.readFileSync(path.join(folder, "scene-tail.json")));
    for (const shot of plan.shots) {
      assert.ok(shot.startSeconds >= 0 && shot.startSeconds + shot.durationSeconds <= 4);
      assert.ok(shot.durationSeconds <= 2, "must select sections, not repeat the entire original");
    }
    const hashes = run("ffmpeg", ["-v", "error", "-ss", "4", "-i", output,
      "-vf", "fps=5", "-f", "framemd5", "-"]).split("\n").filter(x => x && !x.startsWith("#")).map(x => x.split(",").at(-1).trim());
    assert.ok(new Set(hashes).size >= 8, "tail must contain real movement, not the held last frame");
    assert.ok(messages[0].includes("同一原片"));
    assert.equal(await prepareSceneContinuation({ inputPath: input, targetSeconds: 3, outputPath: path.join(folder, "unused.mp4") }), input);
    assert.equal(fs.existsSync(path.join(folder, "unused.mp4")), false);
    assert.equal(fs.readdirSync(folder).some(name => name.startsWith(".scene-tail-")), false);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
