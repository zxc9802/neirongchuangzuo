import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const command = process.argv[2];
if (!["dev", "start"].includes(command)) throw new Error("Expected dev or start");
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), command, ...process.argv.slice(3)], {
  stdio: "inherit", env: { ...process.env, AUTH_MODE: "standalone" },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => process.exit(code ?? 1));
