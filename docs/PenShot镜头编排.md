# AI 带货的 PenShot 切换

AI 带货新增“现有编导 / PenShot 编排”，默认保持现有编导。模型按钮继续用于剧本和格式整理；“直接生成”沿用原来的直接视频生成路径。

PenShot 路径为：现有实拍观察 → 所选模型写短剧本 → 自托管 PenShot 异步分镜 → 所选模型转换为本站格式 → 本站素材、时长、人设和事实审核 → 现有 Seedance 生成。

PenShot 负责镜头顺序和相对节奏；格式转换必须逐镜保留 `fragment_id`，系统按用户选择的总时长同比例适配，再进行原有口播时长校验。不会强制全部图片进入视频。所有镜头仍只能引用当前上传素材，未选用的素材继续说明原因。

模式保存在草稿和任务记录里。切换模式或模型后，需重新编导才能生成视频。旧任务默认解释为“现有编导”。任务提交结果不确定、轮询失败或生成失败时，不自动重新提交 PenShot，也不静默切回原编导；诊断记录保留已接受的 PenShot 任务 ID。

## 本地运行自托管服务

`services/penshot/compose.yaml` 使用官方仓库固定提交 [d772931](https://github.com/neopen/story-shot-agent/commit/d772931588d8b6147dab5b1d1be7abc395eb29b0)，许可证为 [MIT](https://github.com/neopen/story-shot-agent/blob/d772931588d8b6147dab5b1d1be7abc395eb29b0/LICENSE)。源码、依赖与服务独立于本站 Node 运行环境。

1. 安装 Docker Compose，把 `services/penshot/.env.example` 复制为同目录 `.env`，填入 PenShot 使用的 LLM 和 Embedding 提供方配置。此文件已忽略，不提交密钥。
2. 在仓库根目录执行 `docker compose -f services/penshot/compose.yaml up -d --build`。
3. 确认 `http://127.0.0.1:8008/health` 返回健康状态。
4. 本站根目录 `.env.local` 设置 `PENSHOT_API_BASE_URL=http://127.0.0.1:8008`，重启本站本地开发服务。该地址必须是服务根地址，不包含 `/api/v1`。

地址留空时，页面仍可选择 PenShot 查看配置提示，但禁止发起该路径的付费模型调用；现有编导仍可使用。如果本站以后放在另一个容器，应通过容器私网访问 PenShot；本地 Compose 默认只绑定本机回环地址。

PenShot 仍需模型能力，自托管不代表无需模型费用或不会超时。本站记录由本站发起的模型费用；PenShot 自身调用的 LLM/Embedding 费用由其提供方计费，本次未把侧车内部费用并入本站积分账本。不要把未入账当作零费用。

## 验证范围

自动测试覆盖真实 HTTP 契约的模拟返回、完整编排路由、素材选择、顺序和时长约束、提交失败不重复调用、取消、草稿恢复、模式隔离和原有路径回归。

本次开发环境没有 Docker，未构建或启动第三方运行环境，也未发起真实 PenShot 付费生成。需要配置上述模型服务后，用真实素材验收输出质量、耗时及服务重启恢复；不能根据模拟接口测试宣称这些已通过。
