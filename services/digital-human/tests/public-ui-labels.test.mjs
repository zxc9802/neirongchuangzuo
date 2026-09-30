import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("navbar does not render the HeyGen connection button", async () => {
  const source = await read("src/components/Navbar.tsx");

  assert.doesNotMatch(source, /HeyGenConnectButton/);
  assert.doesNotMatch(source, /连接 HeyGen/);
});

test("public lipsync choices are labeled only A, B, and C", async () => {
  const source = await read("src/app/page.tsx");

  assert.match(source, />A<\/div>/);
  assert.match(source, />B<\/span>/);
  assert.match(source, />C<\/div>/);
  assert.doesNotMatch(
    source,
    /PixVerse Lip Sync|VEED Lipsync|HeyGen MCP|OpenLux|fal\.ai|Precision 对口型|稳定对口型，按生成时长计费|默认推荐，适合公网视频和音频素材|高精度对口型，使用套餐额度/
  );
});
