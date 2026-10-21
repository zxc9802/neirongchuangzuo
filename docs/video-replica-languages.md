# 人物复刻保留原视频语言

自 2026-10-21 起，新建复刻统一沿用原视频语言，不再提供生成语言选择。中文、英语、马来语均走原来的 Chatterbox Speech-to-Speech 音色转换，再与人物替换画面合成；不启动翻译、多语言文字配音或 HeyGen 对口型。声音参考仍用于指定目标音色。

创建和启动接口忽略旧客户端传来的 `targetLanguage`；启动旧草稿时清除原语言选择和翻译状态。原 `/language` 接口返回 410，提示刷新页面。语音识别继续用于台词核对，不再因语言分类置信度不足而阻断新任务。

已经开始的历史任务保留原流程和付费回执，以便查询、恢复及结算；不会自动重新提交暂停的任务。数字人的英文、马来语 Chatterbox 配音不受影响。

验证：`npm run check:video`、`npm run test:video`，覆盖界面移除、旧客户端参数、旧草稿、三种原视频语言及任务重启。

## 历史翻译任务说明

以下配置和流程仅用于已开始的历史翻译任务。

生成语言可选 `zh`（中文，默认）、`en`（英语）、`ms`（马来语）。已有任务没有该字段时保留原流程。

| 选择 | 原视频语言 | 处理 |
| --- | --- | --- |
| 中文 | 任意 | 原音色转换流程 |
| 英语 | 英语 | 原音色转换流程 |
| 马来语 | 马来语 | 原音色转换流程 |
| 英语或马来语 | 与选择不同 | 翻译、参考音色配音、HeyGen Precision 对口型 |

复用 Scribe V2 的语音识别结果判断原视频语言，在人物生成和新方案的收费调用之前完成判断。识别不可靠时暂停；对可能被误标为印尼语的马来语，先用已有文本模型核对台词语言。区分依据不足时不猜测。

## 服务端配置

- `VIDEO_HEYGEN_API_KEY`：人物复刻专用 HeyGen 官方 Key，优先于通用 `HEYGEN_API_KEY`，避免本机其他应用的账户配置覆盖它。
- `FAL_KEY` / `FAL_API_KEY` / `VIDEO_FAL_KEY`：沿用原配置，供 Scribe V2、Chatterbox 多语言配音及备用翻译使用。
- `OPENLUX_API_KEY`：主翻译固定使用 `gpt-6-luna`。必要的语言复核沿用已有 `OPENLUX_CHAT_MODEL`。

翻译首先走现有 OpenLux 渠道；HTTP 错误、网络超时或译文格式无效时，改用 fal 的 `openrouter/router`，模型为 `openai/gpt-6-luna`。两条渠道使用同一套翻译要求，备用渠道只查询已保存的任务，不重复提交。平台积分不足或计费预检失败时不会通过切换渠道绕过检查。两条翻译渠道均失败时停止，不进入配音和口型。

本地开发从被 Git 忽略的 `.env.local` 读取；生产环境必须设置部署环境变量。Key 不返回前端，也不写入任务记录。

HeyGen 使用官方 `POST /v3/lipsyncs`，`mode=precision`，不经过 fal 转售。保留画面时长、分辨率和帧率。视频与新配音通过现有素材存储上传，配音按原台词时间范围组装。

## 验证与恢复

译后配音先进行台词核对；过长的配音不会被截断。马来语配音可能被识别器标成印尼语，此时仍必须与指定马来语译文逐字比对通过。

翻译、配音和对口型的提交状态会持久化。主翻译结果不确定时允许切换一次备用渠道，原请求不重发；若原渠道实际已处理，可能仍产生原渠道费用。备用翻译、配音和口型已取得编号的任务只查询原任务；提交结果不确定时暂停。中文和同语言任务不要求配置 HeyGen。

运行 `npm run check:video` 与 `npm run test:video`。覆盖九种语言组合、主翻译故障切换、备用任务恢复、重复提交保护、语言不确定、错误配音、Key 优先级及界面选择。

API 按供应商账单计费。本改动不调整平台现有的成片积分定价。手或商品经过嘴部的效果仍需用对应素材人工预览确认。

## 翻译与配音价格（2026-10-21 核对）

| 服务 | 供应商单价 |
| --- | --- |
| 现有 OpenLux GPT-6 Luna | 公示路由输入约 ¥0.067–0.605/百万 token，输出约 ¥0.336–3.023/百万 token；以实际路由账单为准 |
| fal → OpenRouter GPT-6 Luna | 输入 $0.10/百万 token，输出 $0.50/百万 token |
| Chatterbox 多语言配音 | $0.025/1,000 字符 |

来源：[OpenLux 报价接口](https://www.openlux.ai/api/pricing_new)、[OpenRouter GPT-6 Luna](https://openrouter.ai/openai/gpt-6-luna)、[fal OpenRouter](https://fal.ai/models/openrouter/router)、[Chatterbox 多语言](https://fal.ai/models/fal-ai/chatterbox/text-to-speech/multilingual)。这些短视频译文远低于长上下文加价阈值。

fal 马来语翻译实测输入 67、输出 33 token，`usage.cost = $0.0000232`。结果头 `x-fal-billable-units = 0.00232000` × fal 报价 `$0.01/unit`，与该费用一致；`$0.01/unit` 不是每次请求最低一美分。该次实测与 OpenRouter token 标价一致，没有额外加价。HeyGen 对口型单独收费。
