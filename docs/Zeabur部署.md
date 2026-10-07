# Zeabur 生产启动

整个工作台使用仓库根目录的 `Dockerfile` 部署为一个服务。`npm start` 执行 `scripts/start.mjs`：主站监听 `0.0.0.0:$PORT`，数字人后端使用生产构建，只监听内部 `127.0.0.1:3001`。后端就绪后主站才开放端口；后端退出会停止主站，让部署平台识别故障。

## 控制台设置

1. 服务根目录选仓库根目录，使用根目录 `Dockerfile`。无需另填开发启动命令；镜像默认运行 `node scripts/start.mjs`。不要选 `services/digital-human`，它的 Dockerfile 只包含数字人子项目。
2. 对外 HTTP 端口使用 8080；镜像默认 `PORT=8080`，也支持平台注入的 `PORT`。原有 `PORT=${WEB_PORT}` 可以保留。
3. 在网络/域名中生成或绑定网站域名，再填写服务端环境变量。域名可引用 `${ZEABUR_WEB_URL}`。
4. 保存变量后部署最新代码。可用 `/api/auth/info` 检查后端与主站代理是否就绪，正常返回 `app=digital-human-studio`、`authMode=standalone`。

账号与域名配置如下，数据库连接串直接在 Zeabur 填写，不能提交到 Git：

```dotenv
NODE_ENV=production
AUTH_MODE=standalone
AUTH_DATABASE_URL=新注册用户数据库连接串
INTERNAL_AUTH_DATABASE_URL=原内部账号数据库连接串
AUTH_PUBLIC_URL=${ZEABUR_WEB_URL}
PUBLIC_APP_URL=${ZEABUR_WEB_URL}
PUBLIC_BASE_URL=${ZEABUR_WEB_URL}
```

`AUTH_PUBLIC_URL` 必须解析为网站的 HTTPS 地址。生产代理按这个地址设置转发协议和主机名，登录 Cookie 保留 Secure、HttpOnly 属性。数据库与模型密钥仅在运行时注入；构建镜像不会复制本机 `.env.local`、`.data`、上传文件或现有用户数据。

`DIGITAL_HUMAN_PORT` 是可选的内部端口，默认 3001，不能与对外 `PORT` 相同。日常 Zeabur 部署不需要填写它。本地 `npm run dev` 仍使用原来的 5173/3001。

## 数据保存

此项目仍为单实例运行；在 Zeabur 的硬盘设置中分别挂载：

- `/app/.data`：通用图片、对话调用计数，以及餐饮本地媒体与运行控制。
- `/app/services/digital-human/.runtime`：数字人素材索引、任务状态与本地处理文件。

PostgreSQL 保存账号、会话及餐饮门店资料、任务和正式额度账本；COS 保存媒体对象，不能替代上述本地状态目录的持久化。模型、COS 和默认声音的配置见 [双库登录](双库登录.md) 及数字人环境变量示例。

2026-10-07 只读检查确认旧版本已在线上运行，但应用容器没有挂载这两个目录。**更新前先备份现有目录，挂载后恢复文件，再更新代码。** 新版启动会检查实际挂载并拒绝使用未持久化的容器目录；根目录 Dockerfile 的 VOLUME 声明不能替代平台实际数据卷。餐饮数据库、COS、额度与迁移步骤见 [餐饮小红书实施与部署](餐饮小红书实施与部署.md)。本轮只推送代码，没有执行生产迁移或部署。

## 本地命令

```sh
npm ci
npm run setup:digital-human
npm run build
npm start
```

执行 `npm start` 前需由运行环境注入上述生产变量。Dockerfile 已包含依赖安装、生产构建、FFmpeg 和 Remotion 浏览器准备。

## 本机验证记录

2026-09-30：JavaScript 语法检查通过，生产启动、HTTPS 代理、服务关闭和工作台鉴权共 12 项测试通过。独立目录中的真实生产构建成功，启动日志确认主站监听 `0.0.0.0`，数字人后端监听 `127.0.0.1`。生产构建下已验证普通账号注册、登录、会话查询、退出、未登录拦截及 Secure/HttpOnly Cookie；临时测试账号已从新库清理。

以上是 2026-09-30 的历史记录：首次注册探测曾返回 503，随后注册验证成功，原因未确认。2026-10-07 已同步同事线上登录与生产启动代码，新版生产构建和类型检查通过。本机 Docker daemon 不可用，未构建或运行新版 Linux 镜像；FFmpeg、Remotion 与供应商真实成片不在餐饮此次验证范围内。

Zeabur 官方说明：[Dockerfile 部署](https://zeabur.com/docs/en-US/deploy/methods/dockerfile)、[环境变量引用](https://zeabur.com/docs/zh-CN/deploy/config/environment-variables)。
