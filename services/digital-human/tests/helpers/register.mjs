// 测试专用模块解析钩子注册入口。
// 用法：node --import ./tests/helpers/register.mjs --test tests/*.test.mjs
// 作用：让 Node 原生测试运行器可以直接加载 src/ 下的 TypeScript 源码：
//   1. `server-only` → 空模块（Next 构建期的标记包，Node 里不存在）
//   2. `@/xxx`       → src/xxx
//   3. src 内部的无扩展名相对导入（`./main-app-sso`）→ 自动补 .ts / .tsx
//   4. `next/server` 这类无扩展名包内子路径 → 自动补 .js
import { register } from "node:module";

register("./resolve-hooks.mjs", import.meta.url);
