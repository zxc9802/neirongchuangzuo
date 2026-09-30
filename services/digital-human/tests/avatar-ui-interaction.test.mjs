import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("hover video cannot intercept the empty-cover extraction button", async () => {
  const source = await readFile("src/app/avatars/page.tsx", "utf8");
  assert.match(
    source,
    /<video[\s\S]*?pointer-events-none[\s\S]*?立即抽取封面/,
  );
});
