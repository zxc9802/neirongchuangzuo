# 数字人成品保留与验证

## 保留规则

网站已完成的数字人口播与配音从首次完成时间起保留 72 小时。任务存储固定 `completedAt`，后续日志、计费记录或状态查看不会延长保留期。旧的 completed 记录第一次访问时以原 `updatedAt` 补齐完成时间并保存。

`GET /api/tasks?completed=true` 仍执行原有账号权限校验，只返回未过期、已完成且可交付的任务。公开 DTO 增加毫秒时间戳 `completedAt`、`expiresAt`、`outputExpired`；`results.downloadUrl` 为受权限保护的下载入口，预览继续使用 `finalVideoUrl` / `exactAudioUrl`。没有生成缩略图时不要把上传形象封面当作成品。

72 小时整点即拒绝输出预览、下载和恢复；旧 `/jobs/<taskId>/...` 与 `/uploads/...` 直链仍由 middleware 拒绝，提供商输入独立使用已有的 6 小时规则。原视频入口保持原有归属检查。

任务访问和每分钟定时检查执行清理；服务停止期间不会清理文件，恢复运行后执行检查。只删除 `.runtime/jobs/<taskId>` / 兼容的 `public/jobs/<taskId>` 中已知生成文件及生成分段；不跟随符号链接或 junction。COS 只处理本站任务已知的固定对象名及记录中的分段编号，不扫描 bucket，也不根据外部返回 URL 删除对象。任务与计费记录保留用于防重复与审计。

上传形象、原视频、源音色、其他任务输入、共享 TTS 缓存不属于此次成品删除范围。没有触发真实生成或真实 COS 操作。

## 2026-09-30 验证记录（Windows）

- 保留、公开 DTO、任务隔离、任务转动效、middleware：42 项通过。
- `npx tsc --noEmit --incremental false` 通过。
- 新增 `task-output-retention.test.mjs` 验证 72 小时边界、日志不续期、上传/原片/其他任务输入保护、junction 防护、任务墓碑、下载/预览权限与到期拒绝。
- `public-data-serialization.test.mjs` 原有写死日期导致已完成 fixture 被正确判断为过期；已改为相对当前时间，并重新通过全部序列化测试。
- 全量有界运行使用 `--test-timeout=30000`：234 项，215 通过、17 失败、1 取消、1 跳过。其中 `provider-confidentiality.test.mjs` 的源码表达式断言因新增工作目录常量触发，已恢复其原 `STATE_DIR` 声明并单独通过。没有把此历史全量结果宣称为全绿。

其余失败在临时测试加载器关闭新过期判定与删除后仍复现。对自行读取并转译 TypeScript 的 bug-regressions 沙箱另做读源码替换对照，确认实际替换 10 次，8 项失败名称完全相同；临时对照不修改产品代码。

| 文件 / 测试行 | 精确测试名或摘要 | 观察到的限制 |
| --- | --- | --- |
| avatar-legacy-recovery.test.mjs:60 | admin recovery merges unindexed legacy videos into a non-empty cloud index without duplicates | 默认未配置旧 COS 主机，迁移 fixture 不被识别 |
| avatar-legacy-recovery.test.mjs:248 | failed legacy copies keep the old record and retry on the next admin request | 同上，旧对象复制没有进入预期 mock |
| avatar-legacy-recovery.test.mjs:326 | legacy migration preserves edits made while an object copy is in flight | await copyStarted 不会 resolve；30 秒有界取消。此文件不导入 TaskStore，与新增 unref 定时器无关 |
| bug-regressions.test.mjs:79 | B6: retrying a claimed voice upload must preserve the first voice audio | 沙箱依赖覆盖键使用正斜杠，而 load 先用 Windows path.normalize，覆盖未命中 |
| bug-regressions.test.mjs:147 | B8: cloud recovery must establish duration and all deliverables before settlement | 相同依赖覆盖问题，预期对象检查未发生 |
| bug-regressions.test.mjs:207 | MP3 output can be previewed and downloaded only by its owner after settlement | 相同依赖覆盖问题；预期 404 得到 200。新增独立运行时权限测试通过 |
| bug-regressions.test.mjs:318 | B9: recovery of a split job must recover all video segments | 相同依赖覆盖问题，真实适配器提示未配置 fal API Key |
| bug-regressions.test.mjs:381 | B8: valid cloud media without a report is probed, rebuilt and settled once; concurrent recovery is rejected | 相同依赖覆盖问题，找不到原声音轨 |
| bug-regressions.test.mjs:454 | B6: concurrent audio claims preserve the winner, and retrying a video upload preserves converted audio | 相同依赖覆盖问题，预期一次调用实际零次 |
| bug-regressions.test.mjs:512 | B9: incomplete split recovery stays failed and retry only fetches the missing segment | 相同依赖覆盖问题，实际为未配置 OpenLux API Key |
| bug-regressions.test.mjs:543 | B9: new VEED split jobs emit persistent identities for every segment | 相同依赖覆盖问题，实际为未配置 fal API Key |
| main-app-sso.test.mjs:8 | shuziren site keeps the main-site SSO callback and encrypted session contract | 断言原站写死 SSO URL，但本项目示例配置有意留空 |
| media-path-policy.test.mjs:23,61 | resolveAllowedLocalMediaPath... / mediaRoots... | Linux `/srv/app` 预期与 Windows `D:\\srv\\app` 不一致 |
| media-path-policy.test.mjs:73,111 | CosService.getManagedObjectKey... / legacy avatar key parsing... | 假定配置旧 bucket，而本项目默认留空 |
| media-response-hardening.test.mjs:46（after hook） | 清理临时目录 | Windows 临时媒体目录删除得到 EPERM；16 项媒体行为断言通过 |

以上广泛环境/上游 fixture 问题没有在此次资产需求中更改业务权限、供应商配置或部署参数来规避。
