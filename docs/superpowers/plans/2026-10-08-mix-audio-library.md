# 混剪音色库、背景音乐库与原声模式实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 用户上传并管理自己的音色和背景音乐，混剪选择合成配音或保留素材原声，两种模式均可选配乐。

**Architecture:** 复用主站鉴权、私有 Python 混剪服务、SQLite、腾讯 COS 和现有 FFmpeg 引擎。音频对象按主站已验证账号隔离；独立的 `MIX_AUDIO_COS_SECRET_ID`、`MIX_AUDIO_COS_SECRET_KEY`、`MIX_AUDIO_COS_BUCKET`、`MIX_AUDIO_COS_REGION` 配置不改变其他功能的存储。新加坡桶为 `hjyp-1410143389`、地域 `ap-singapore`，真实凭据只通过进程环境注入。

**Tech Stack:** FastAPI, SQLite, cos-python-sdk-v5, FFmpeg, existing browser JavaScript.

用户已明确：不用人声仅指不合成配音，必须保留原素材声音。缺少原音的素材按其实际情况处理。无配音时沿用文案阅读速度估算时间轴并明确说明，不冒充 TTS 对齐；文案继续用于素材匹配和可选字幕。

## Task 1: 私有音频库

- [x] 新增 `services/mix/python/audio_library.py`、`tests/mix-python/test_audio_library.py`，依赖添加腾讯 COS Python SDK。
- [x] `AudioLibrary(root, client=None, env=None)` 提供 `status()`、`list(owner, kind)`、`upload(owner, kind, name, path)`、`get(owner, id, kind=None)`、`signed_url(owner, id, expires=3600)`、`download(owner, id, folder)`、`delete(owner, id)`。`get` 返回内部元数据（含 key、sha256）；公开列表只含 id、kind、name、duration、bytes、同源试听地址。
- [x] `attach_audio_library(app, library, owner, in_use=None)` 暴露 GET/POST `/v1/mix/audio?kind=voice|music&name=...`，POST 为原始音频流；DELETE `/v1/mix/audio/{id}`；GET/HEAD `/v1/mix/audio/{id}/stream`。鉴权后才能返回短期 COS 签名链接。
- [x] MP3/WAV/M4A；音色输入最多 32 MiB、音乐最多 128 MiB。使用受限本地音频解码验证，音色取前 15 秒转为单声道 WAV；音乐保存原上传音频。COS 对象 ACL private，Key 由服务生成，按 owner/kind/id 隔离。SQLite 保存元数据，同账号同类音频摘要可复用；临时文件清理；不改变桶全局策略。
- [x] 删除被可继续制作的任务使用的音频时返回 409；COS 缺配置不阻止无配乐的原声混剪。测试覆盖真实解码、伪装文件、账号隔离、删除、缓存、签名链接和配置缺失。

## Task 2: 混剪引擎与路由

- [x] 新建任务增加 `voice_mode=synthesized|original`、可选 `voice_id`、`music_id`；保留旧任务默认配音行为和默认音色 URL 兼容。请求仅接收不透明音频 ID，拒绝用户提供云端地址、COS Key 和凭据。
- [x] 合成模式支持选择上传音色，不再强制填写全局 `INDEXTTS_SPEAKER_AUDIO_URL`；COS 签名更新使用稳定音色缓存标识，保持已付费阶段恢复与请求幂等。
- [x] 原声模式不请求 TTS。浏览器取片保留音轨，逐镜头按视频相同裁切区间保留原音；无音轨片段补静音以保持拼接时序。字幕修正和质检修正不能丢失原声。
- [x] 两种模式支持音乐裁切/循环、淡入淡出与音轨混合，保持原声音量清晰。质检对原声模式不要求朗读文案，对配乐检查实际导出音轨。
- [x] 主站只代理白名单音频路由，保留查询参数、流式上传、Range/HEAD 和现有鉴权/同源保护。运行设置允许上述四个 COS 变量；错误清理隐去新增密钥。
- [x] 分别运行真实 FFmpeg 原声、纯配音、原声+音乐、配音+音乐与无音轨素材测试，覆盖切点、总时长和恢复不重复付费。

## Task 3: 前端与部署说明

- [x] 在现有右侧设置栏添加人声模式、音色选择、音乐选择及小型音频库管理；支持上传、试听、删除、真实进度和错误提示，沿用现有布局。
- [x] 按账号清空音频状态并拒绝旧账号迟到响应；重复点击不会重复提交；制作中固定所选参数。
- [x] 默认保持配音模式，未选上传音色时可使用管理员默认音色；原声模式可在缺配音配置时制作。背景音乐默认不选，不生成音乐。
- [x] 更新环境变量示例和部署文档；列出 4 个独立 COS 配置及原模型密钥。补充前端与主站路由回归。

## 验证与交付

- [x] 测试先复现缺少功能再实现；私有 COS 使用实际提供的桶完成受控上传、签名读取、删除检查，不保留测试对象，不输出真实凭据。
- [x] 混剪 Python 和 JavaScript 回归、语法与类型检查；当前 main 基线的全量测试通过，无需修改其他功能。
- [x] 顺序进行需求符合性和代码质量审查，修正后再次验证；准备完整环境变量清单，记录真实网页账号服务的验收限制，不把未测试的线上运行声称为已验证。
