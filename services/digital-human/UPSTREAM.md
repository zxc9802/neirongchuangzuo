# 数字人模块来源

- 上游仓库：https://github.com/zxc9802/shuzirenzhinengti
- 导入版本：`393d2eccd7d6e1b1d7423f40e1d7e97cef73b2cd`
- 导入日期：2026-09-23
- 按上游 Git 跟踪文件整体导入，保留源码、锁文件、测试及文档；未复制 Git 元数据、用户素材、运行记录或个人密钥。
- 本地调整：清空 `src/lib/config.ts` 中原项目的 COS 桶/地域默认值；把 `.env.example` 改为本项目无密钥的本地联调模板；纠正 README 的配置入口说明；增加 `/api/digital-human/status` 公开配置就绪状态，不返回密钥。配置状态不等于供应商实测可用。
- 修复 `src/lib/server/public-data.ts` 的默认音色公开数据：没有原始 `audioUrl` 或 `audioPath` 时，`toPublicVoice` 返回空 `audioUrl`，避免未配置参考音频的默认音色被前端误判为可试听或可用于生成。
- 新增 `/api/digital-human/library` 及 `src/lib/server/digital-human-library.ts`，为本站素材与作品展示区提供稳定游标分页、分类数量、当前选择和进行中任务。沿用上游访问权限与公开数据序列化，原形象及任务完整列表接口不变。

上游生成、鉴权和任务接口继续复用。自带前端保留用于验证接口；正式工作台由本项目统一开发，保留本站蓝白风格，采用上方生成、下方懒加载素材与作品的布局，入口为 `http://127.0.0.1:5173/#avatar`，页面代码在根目录 `design/digital-human.js`、`design/digital-human.css`，接口适配在 `design/digital-human-api.js`。

根目录 `preview.mjs` 负责把同源接口及媒体请求流式转发到 3001，保留会话、媒体 Range 和事件流；根目录 `npm run dev` 同时启动工作台和后端，或复用已经运行的数字人服务。`npm run dev:design` 只启动工作台与代理。本地前端来源使用 `AUTH_PUBLIC_URL=http://127.0.0.1:5173`，原生服务来源使用 `AUTH_DESKTOP_URL=http://127.0.0.1:3001`。仅本机开发可使用无 SSO 的开发身份，生产鉴权规则保留。

开发命令和边界见仓库根目录 README；前端接口见 `../../docs/数字人前端对接.md`。上游 Docker、桌面端和主站集成配置仍保留供参考，正式部署前需按本项目地址和账号方案配置。
