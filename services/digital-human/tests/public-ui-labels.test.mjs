import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PUBLIC_LIPSYNC_ENGINES } from "../src/lib/public-contract.ts";

const read = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("navbar does not render the HeyGen connection button", async () => {
  const source = await read("src/components/Navbar.tsx");

  assert.doesNotMatch(source, /HeyGenConnectButton/);
  assert.doesNotMatch(source, /连接 HeyGen/);
});

test("public lipsync choices show the three qy tiers without retired options or provider names", async () => {
  const source = await read("src/app/page.tsx");

  assert.deepEqual(PUBLIC_LIPSYNC_ENGINES, [
    { id: "b", label: "qy-标准" }, { id: "d", label: "qy-旗舰" }, { id: "e", label: "qy-至臻" },
  ]);
  assert.match(source, /PUBLIC_LIPSYNC_ENGINES\.map/);
  assert.doesNotMatch(source, /setEngine\("[ac]"\)|>A<\/div>|>C<\/div>|LatentSync 对口型|原版对口型/);
  assert.doesNotMatch(
    source,
    /PixVerse Lip Sync|VEED Lipsync|HeyGen MCP|OpenLux|fal\.ai|Precision 对口型|稳定对口型，按生成时长计费|默认推荐，适合公网视频和音频素材|高精度对口型，使用套餐额度/
  );
});
