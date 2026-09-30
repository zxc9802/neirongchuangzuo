import sharp from "sharp";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const assets = new URL("../desktop/assets/", import.meta.url);
const svg = await fs.readFile(new URL("icon.svg", assets));
await sharp(svg).resize(1024).png().toFile(fileURLToPath(new URL("icon.png", assets)));
const png = await sharp(svg).resize(256).png().toBuffer();
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
await fs.writeFile(new URL("icon.ico", assets), Buffer.concat([header, png]));
if (process.platform === "darwin") {
  const os = await import("node:os");
  const path = await import("node:path");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "studio-icons-"));
  const iconset = path.join(temporary, "Studio.iconset");
  await fs.mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) await sharp(svg).resize(size * scale).png().toFile(path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", fileURLToPath(new URL("icon.icns", assets))]);
  await fs.rm(temporary, { recursive: true });
}
