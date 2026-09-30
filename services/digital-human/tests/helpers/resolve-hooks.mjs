import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC_DIR = path.resolve(fileURLToPath(new URL("../../src/", import.meta.url)));
const SERVER_ONLY_STUB = new URL("./server-only-stub.mjs", import.meta.url).href;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".mjs", ".js"];

function withExtension(filePath) {
  if (path.extname(filePath) && existsSync(filePath)) return filePath;
  for (const ext of EXTENSIONS) {
    if (existsSync(filePath + ext)) return filePath + ext;
  }
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    for (const ext of EXTENSIONS) {
      const index = path.join(filePath, `index${ext}`);
      if (existsSync(index)) return index;
    }
  }
  return filePath;
}

function isInsideSrc(parentURL) {
  if (!parentURL?.startsWith("file:")) return false;
  const parentPath = fileURLToPath(parentURL);
  return parentPath.startsWith(SRC_DIR + path.sep);
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return { url: SERVER_ONLY_STUB, shortCircuit: true };
  }

  if (specifier.startsWith("@/")) {
    const target = withExtension(path.join(SRC_DIR, specifier.slice(2)));
    return { url: pathToFileURL(target).href, shortCircuit: true };
  }

  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    isInsideSrc(context.parentURL)
  ) {
    const target = withExtension(fileURLToPath(new URL(specifier, context.parentURL)));
    return { url: pathToFileURL(target).href, shortCircuit: true };
  }

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    // 包内子路径缺少扩展名（如 next/server）时补 .js 再试一次
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("node:") &&
      !path.extname(specifier)
    ) {
      return nextResolve(`${specifier}.js`, context);
    }
    throw error;
  }
}
