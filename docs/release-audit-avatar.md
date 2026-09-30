# 数字人服务上线准备审查

检查日期：2026-09-30。范围：`services/digital-human` 源码、运行中的本地配置就绪接口、类型检查、完整有界测试、隔离生产构建、依赖审计、部署文件。未修改业务代码，未访问公司服务器、生产数据库或 COS；未触发付费生成。本文中的 P0 表示正式开放前必须解决的阻塞，P1 表示上线前应完成的验证或可靠性工作。

## 结论

数字人已经有相当完整的任务、上传、账号隔离、计费预留/结算、恢复及成品过期逻辑，但当前本地并未接通真实生成依赖，也没有经过公司生产账号、存储及生成链路验收。不能把开发服务能打开等同于已可正式上线。

共用公司现有数字人能力，优先让新前端对接现有数字人服务 API；不要部署两个独立写进程后直接让它们共用同一 COS 索引。

## 阻塞及证据

| 等级 | 检查结果与影响 | 证据 | 完成条件 |
| --- | --- | --- | --- |
| P0 | 真实配音、口型和可访问媒体均未就绪。安全状态接口实际返回 `ttsReady=false`、`mediaReady=false`、三个口型方案 `available=false`、`ready=false`。网站根目录已有的图片/Agent 密钥不代表数字人也接通。 | `services/digital-human/src/app/api/digital-human/status/route.ts:23`；2026-09-30 GET `http://127.0.0.1:3001/api/digital-human/status` | 决定复用现有服务或独立配置；至少一条配音、口型、媒体公网访问链路真实通过；用一段短视频完成上传、配音、成片、预览、下载，并核对成本。 |
| P0 | 生产账号方案需要明确。开发时没有 SSO 会使用共享本地身份；生产缺少鉴权配置会返回 503，因此当前开发模式不能直接上公网。 | `src/lib/access-control.ts:41`、`src/middleware.ts:79` | 接公司统一登录，或 `AUTH_MODE=standalone` 配独立 PostgreSQL；验证两账号不能互读任务、形象、音色及成品；根网站所有模块也必须接同一身份。 |
| P0，若复用现网 | COS 索引路径写死，两个独立服务共桶会共读写任务、形象、音色的整份索引；账号和任务数据可能互相覆盖或混用。 | `src/lib/store/task-store.ts:124` (`_system/tasks.json`)、`src/lib/store/avatar-store.ts:35` (`_system/avatars.json`)、`src/lib/store/voice-store.ts:24` (`_system/voices.json`) | 复用一个服务的 API；若必须单独部署，使用独立桶或为全部对象/索引/缓存实现完整命名空间，不只改文件夹显示名称。 |
| P0，若接主站 | SSO 产品标识、Cookie 名、默认域名及积分规则仍带上游契约。只填两个 Secret 并不完成接入。 | `src/lib/main-app-sso.ts:3`、`:143`、`:320`、`:369`；`src/lib/main-app-billing.ts:13`、`:165` | 公司确认产品标识、回调域名、交换/校验接口、注销、账本接口；验证预留、实际结算、失败释放、重复请求和恢复不重复扣费。当前固定 20 积分/秒、0.20 元/秒应由公司确认。 |
| P1 | 独立账号能隔离身份，但默认不向主站扣积分，不能直接当成已实现商业收费。 | `src/lib/server/standalone-auth.ts:155`、`src/lib/main-app-billing.ts:41` | 确定内测白名单、免费额度或接入统一计费；公开注册和收费策略一致。 |
| P1 | 单进程后台任务；进程退出不等于队列可自动接续。恢复接口主要恢复已有供应商结果，不能保证所有中断阶段自动重跑。 | `src/app/api/tasks/route.ts:160`；`src/lib/engine/task-execution.ts:2`；`src/lib/server/generation-limit.ts:21`；`src/app/api/tasks/[id]/recover/route.ts:35` | 首发限制一个任务写实例；实测配音前/供应商已受理/成片下载中重启；有明确卡住任务处置和账本对账。需要多副本时先做持久化队列和分布式锁。 |
| P1 | 任务与素材索引主要是 JSON 文件及整份 COS 镜像。任务主文件写入非原子，写失败仅记日志；多实例不是安全的数据库替代。 | `src/lib/store/task-store.ts:170`、`:177`、`:184`；形象/音色 Store 同类实现 | 持久卷、磁盘余量告警、备份与恢复演练；单实例首发。若要求多实例和较高可靠性，将任务状态与账本迁移数据库。 |
| P1 | 上游 Docker/Compose 是起点，不能原样当本站生产部署。Node 20 基础镜像已 EOL；主 Compose 暴露 `3000:3000`，公网地址是占位符，未传入本站主站 URL/SSO 交换配置；无 healthcheck、资源上限和备份策略。 | `Dockerfile:2`、`:18`；`docker-compose.yml:10`、`:15`、`:30`；`docker-compose.standalone.yml:8` | 升级并验证受支持 Node LTS；完善站点域名/SSO配置、内网监听或网络隔离、HTTPS反向代理、上传体积与超时、SSE/Range、健康检查、限额、持久卷和回滚。 |
| P1 | 完整测试未全绿，生产容器也没有完成实机验收。 | 本文验证记录；`tests/RETENTION.md` | 在目标 Linux/Node 版本 CI 修复跨平台 fixture，补临时 PostgreSQL 集成测试；容器构建、启动和生产代理冒烟通过。 |
| P1 | 生产依赖审计检出 6 个受影响包（5 高、1 中）。部分是不可达/未启用功能的潜在风险，不能直接说已发现 6 个可利用网站漏洞。 | 本文依赖表、`package-lock.json` | 升级可修复依赖、对不可升级项验证调用路径并记录处置；重新测试。没有执行自动升级。 |

## 账号、存储、服务怎么共用

| 内容 | 可共用方式 | 当前限制 |
| --- | --- | --- |
| 同一台服务器 | 不同容器/进程、内部网络、独立持久目录、统一反向代理 | 需要现网部署图、空余 CPU/内存/磁盘和维护窗口；尚未获得服务器资料。 |
| 数字人生成能力 | 新网站经受信任后端对接现有数字人 API | 必须明确登录身份转交、Cookie/会话作用域、权限、计费及跨站调用策略。 |
| 公司登录与积分 | 复用已存在 SSO 和账本接口 | 上游固定 `shuziren` 产品与费率需公司确认；不得从前端自报用户身份。 |
| PostgreSQL 实例 | 可共实例，采用专用数据库/权限/Schema | 现有独立账号代码会创建固定 `digital_human_auth` Schema；若两个独立服务共相同数据库，该表空间也相同。应有意设计共享账号或隔离数据库。 |
| COS | 优先让现有服务管理自己的桶；新服务通过 API 访问 | 两个独立任务 Store 不能直接共写 `_system/*.json`；私有桶、签名访问、最小权限和清理策略需验收。 |
| 原上传与成品保留 | 成品成功起 72 小时；原形象、声音不属于自动删除范围 | 已实现访问拒绝及定时清理；生产 COS 删除权限、服务停止后补清理、失败告警需实测。原上传未设置自动过期，应另定配额/用户删除/备份策略。 |

## 本次验证记录

- `npx tsc --noEmit --incremental false`：通过。
- `node --import ./tests/helpers/register.mjs --test --test-timeout=30000 tests/*.test.mjs`：234 项，216 通过、16 失败、1 取消、1 跳过，约 31 秒。有明确时间上限，未遗留测试进程。
- 失败类别与 [上一次保留期检查基线](../services/digital-human/tests/RETENTION.md) 一致：8 个 Windows 沙箱依赖覆盖/路径问题、旧 COS fixture 配置假定、SSO 示例地址断言、Linux 绝对路径假定、Windows 临时目录清理 EPERM，以及一个等待旧 COS mock 的超时取消。本次未引入业务修复来规避测试。
- PostgreSQL 账号集成测试因未设置临时 `TEST_DATABASE_URL` 跳过；不能宣称独立账号数据库注册登录已实测。
- 正在使用的本地 `.next` 和服务保持不变；生产构建在无密钥、无 `.env.local`、无运行数据的隔离副本执行。首次 C 盘临时副本遇到 esbuild 写权限及跨盘 junction 解析限制；这是隔离环境限制，不作为源码编译失败结论。改用同盘隔离目录后，完整 `npm run build` 通过（Remotion 模板、effect-frame、Next 15.5.24 编译、类型检查、页面数据与静态生成，退出码0）。使用 Windows Node 24.15.0，不能替代 Linux 容器验收。
- 对同盘隔离构建启动一次生产服务（仅监听127.0.0.1:3017，无 SSO、无密钥），实测 `/api/session`、`/api/tasks`、`/api/digital-human/status` 均503，旧成品直链 `/jobs/test/final.mp4` 和禁用配置接口 `/api/settings` 均404。检查结束即停止该隔离进程；没有停止3001开发服务。
- Docker CLI 可用，但本机 Docker daemon 不在运行，未执行真实 Linux 镜像构建/启动。没有为审查启动 Docker、改防火墙或访问公司环境。
- 未调用模型、没有新计费任务，没有真实 COS 删除、没有部署。

## 依赖审计

2026-09-30 `npm audit --omit=dev --json`，下表版本由 `npm ls` 与锁文件核实。修复版本是安全公告/注册表候选值，实际升级仍需兼容性验证。

| 包 | 当前版本 | 审计等级 | 处置依据 |
| --- | --- | --- | --- |
| `@mariozechner/pi-coding-agent` | 0.73.1 | 高 | 旧包名无修复版；维护者建议迁到 `@earendil-works/pi-coding-agent >=0.78.1`。不能采用 audit 建议的简单降级当作修复。现有调用用 `AuthStorage.inMemory()`、`noExtensions:true`，临时扩展路径风险在本调用方式未确认可达。见 [维护者公告](https://github.com/earendil-works/pi/security/advisories/GHSA-jfgx-wxx8-mp94)。 |
| `extract-zip` | 2.0.1 | 高 | 当前注册表最新仍为 2.0.1，公告未给修复版；经 Pi 引入。需迁移/替换或证明不处理不可信压缩包。见 [公告](https://github.com/advisories/GHSA-jmr9-qjv8-65gv)。 |
| `brace-expansion` | 5.0.9 | 高 | 候选 5.0.12；见 [递归拒绝服务公告](https://github.com/advisories/GHSA-qhr7-859c-m2p7) 与 [补充公告](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)。 |
| `fast-uri` | 3.1.6 | 高 | 3.x 候选至少 3.1.8，注册表最新4.2.1不能未经验证跨大版本升级；见 [authority 公告](https://github.com/advisories/GHSA-qw65-cvwx-89v3) 与 [补充公告](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj)。 |
| `ip-address` | 10.5.0 | 中 | 候选10.7.2；见 [地址族校验公告](https://github.com/advisories/GHSA-j6r3-76f7-8jcv)。 |
| `sharp` | 0.35.3 | 高 | Next 15.5.24 引入；至少0.35.4修复，注册表最新0.35.5；见 [维护者公告](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c)。 |

锁文件证据：`services/digital-human/package-lock.json:2133`、`:4335`、`:5565`、`:5643`、`:6340`、`:7011`、`:8384`。运行时升级依据：[Node.js 官方版本状态](https://nodejs.org/en/about/previous-releases)。

## 上线验收顺序

1. 公司同事提供现网 API、账号/账本契约、部署方式、服务端地址、现有数据隔离方式和服务器资源，先确定复用服务还是新部署。
2. 统一全站身份并确定收费/额度；完整配置域名、对象存储、配音和至少一个口型供应商。
3. 修复生产依赖与测试门槛，在目标 Linux + 受支持 Node LTS 构建容器；备好持久卷、监控、备份与回滚。
4. 用两个普通账号做上传/生成/下载/越权隔离验收，做一次失败、一次重启恢复及积分对账，做一次 72 小时边界/清理演练。
5. 先小范围白名单开放，记录单任务耗时、成功率、资源峰值及真实成本，再确定外部用户并发和配额。
