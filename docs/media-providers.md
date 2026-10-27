# 多平台生图与 TTS

生图在控制台“表情包 → 生成 → 生图服务”配置，保存后新任务立即生效。TTS 在“插件 → 回复语音”配置，保存或启用后重启桥接生效。原有 ComfyUI 局域网地址及 Edge 音色配置继续兼容。

| 功能 | 平台 | 默认模型 | 接口 |
| --- | --- | --- | --- |
| 生图 | ComfyUI 异步代理 | 服务端工作流决定 | `/v1/images/generations`，提交后轮询任务 |
| 生图 | OpenAI | `gpt-image-1` | `/v1/images/generations`，同步 Base64 或 URL |
| 生图 | 硅基流动 | `Kwai-Kolors/Kolors` | `/v1/images/generations`，同步图片 URL |
| 生图 | 自定义 OpenAI 兼容 | 自行填写 | `/v1/images/generations`，同步 `data[].b64_json` 或 `data[].url` |
| TTS | Edge TTS | `zh-CN-XiaoxiaoNeural` 音色 | 本机 `python -m edge_tts` |
| TTS | OpenAI | `gpt-4o-mini-tts`，音色 `alloy` | `/v1/audio/speech`，二进制音频 |
| TTS | 硅基流动 | `FunAudioLLM/CosyVoice2-0.5B`，音色 `FunAudioLLM/CosyVoice2-0.5B:alex` | `/v1/audio/speech`，二进制音频 |
| TTS | 自定义 OpenAI 兼容 | 自行填写模型，音色可留空使用服务默认值 | `/v1/audio/speech`，二进制音频 |

模型和音色可修改，实际可用项取决于服务和账号权限。选择不同平台时会填入相应默认值。API 地址既可填根地址，也可包含 `/v1` 或代理前缀，例如 `https://example.com/proxy/v1`，不会重复追加 `/v1`。ComfyUI 异步代理需使用根地址；本选项不会向 ComfyUI 原生 `/prompt` 发送工作流。

## 可选密钥

生图和 API TTS 均有密码输入框。未设置密钥或勾选“不使用密钥”时，完全省略 `Authorization`；非空密钥作为 `Authorization: Bearer <密钥>` 发送。这里控制的是接口鉴权，传输加密由 HTTPS 决定。

保存后的密钥不返回浏览器。显示“已保存”时留空保留原密钥，输入新值替换，勾选“不使用密钥”清除。切换平台或地址时清除旧密钥，需要为新服务重新填写。自定义兼容服务也可以不设密钥。

主动编辑并清空密钥输入框也会选择“不使用密钥”，保存后关闭鉴权。ComfyUI 的密钥同样可留空；这表示不发送认证头，HTTPS 才负责传输加密。有未结束的生图任务时暂不能切换平台、地址或模型，可以继续修改密钥或关闭生图，待任务完成或确认解除占用后再切换。

密钥存于本机私有 `config.json`，不会写入生图任务快照或传给 DSH。任务、图片和提示词在私有 `.imagegen-runtime` 中；公开打包与导出会排除该目录。图片 URL 与 API 同源时可携带服务密钥；其他来源只允许 HTTPS，绝不转发 API 密钥，不跟随重定向。

## 参数适配

ComfyUI 代理沿用 `prompt`、`negative_prompt`、`width`、`height`、uint64 `seed`、`steps`、`cfg`。其模型由服务端工作流配置，不发送 `model`。

硅基流动发送 `model`、`prompt`、`image_size`，并将步数、CFG 映射为 `num_inference_steps`、`guidance_scale`；种子范围为 0 至 9999999999。当前接口未列出的 `batch_size` 不发送，客户端仍校验每个任务只接收一张图片。

OpenAI 和兼容接口发送 `model`、`prompt`、`size`、`n: 1`；反向描述附在提示词末尾。OpenAI GPT Image 将横图、竖图分别映射为 `1536x1024`、`1024x1536`，DALL-E 3 使用 `1792x1024`、`1024x1792`，DALL-E 2 仅支持方图。自定义接口使用控制台显示的实际宽高。这两种平台不发送采样步数、CFG 和种子，填写这些参数时会在提交前拒绝。

API TTS 发送 `model`、`input`、`voice` 和 `response_format`；音频格式通过 `responseFormat` 选择 `mp3` 或 `wav`，缺省仍为 MP3。自定义兼容平台的 `apiVoice` 缺失、为空或仅含空白时省略 `voice`，使用服务默认音色；OpenAI、硅基流动保留各自预设音色。不会把 Edge 音色自动当成 API 音色，Edge 输出仍为 MP3。

音频大小上限 10 MiB，文本、超时及取消沿用原插件限制。WAV 占用空间较大，可通过 `maxChars` 限制单段长度。任何语音错误均保留文字回复，不自动重试生成请求。

## 语音语种

回复语音 v1.4.0 新增独立的 `speechLanguage`，默认 `auto`（自动），不触发翻译。关闭“合成前翻译”后，原文直接送入 TTS；选择日语不会把中文变成日语。

| 平台 | 语种行为 |
| --- | --- |
| Edge TTS | 可选中文、日语、英语、韩语、法语、德语、西班牙语、意大利语、葡萄牙语、俄语。选择后预填对应音色；运行时保留同语种的自定义音色，遇不同语种音色则选用该语种默认值。`auto` 保留原音色。 |
| OpenAI、硅基流动 | 目前仅提供 `auto`，沿用原文、模型及音色决定语言，不发送未支持的 `language` 参数。切换到这些平台时表单恢复自动。 |
| 自定义 OpenAI 兼容 | 非 `auto` 时发送扩展字段 `language`（如 `ja`、`zh`、`en`），需要服务自身支持；`auto` 完全省略该字段，兼容旧接口。 |

语种选择和翻译开关分别保存；翻译目标字段改名为“翻译目标语言”，仅在开启翻译时显示。关闭翻译会保留之前的翻译偏好。Irodori 当前模型仅支持日语；其局域网服务声明接受 `auto` 或 `ja`，其他语种会被拒绝，不能通过参数扩展模型的语言能力。

## 合成前翻译

回复语音 v1.3.0 增加可选的“合成前翻译”，参考 `miku05231/astrbot_plugin_translate_tts` 的先翻译、再调用 TTS 的顺序。`translationEnabled` 默认 `false`，目标语言 `targetLanguage` 默认“日语”，可填写附加要求 `translationPrompt`；`translationTimeoutMs` 默认 60000，范围为 1000 至 120000 毫秒。

文字发送成功后，翻译跟随当前 DSH 模型及模型补丁，在全新、无工具、无聊天历史的会话中运行。QQ 保留原文，只有译文进入 TTS。提示词要求只返回适合朗读的译文，不增加动作、喘息、笑声或表情符号；这属于模型约束，不是对任意输出的确定性清洗。翻译失败、为空、超时或被取消时跳过语音，不把原文作为回退输入。

翻译与合成分别计时，开启后会增加一次模型请求和相应延迟。配置保存后重启桥接生效。翻译正确不代表 TTS 内容一定正确，仍需核对实际音频。

## 配置示例

以下为无密钥的兼容服务示例，按实际部署填写模型和音色：

```json
{
  "imagegen": {
    "enabled": true,
    "provider": "openai-compatible",
    "baseUrl": "http://127.0.0.1:8190/v1",
    "model": "your-image-model",
    "apiKey": ""
  },
  "plugins": {
    "reply-tts": {
      "provider": "openai-compatible",
      "speechLanguage": "auto",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "model": "your-tts-model",
      "apiVoice": "your-voice",
      "responseFormat": "mp3",
      "apiKey": "",
      "translationEnabled": false,
      "targetLanguage": "日语",
      "translationPrompt": "",
      "translationTimeoutMs": 60000,
      "maxChars": 600,
      "timeoutMs": 60000
    }
  }
}
```

Irodori-TTS 的以下无密钥配置于 2026-10-25 完成接口接入。最初音频内容异常；远端停用错误对齐 LoRA、改用原模型和真红参考音频后，短句、真实翻译及 QQ 转码后的内容核对通过：

```json
{
  "provider": "openai-compatible",
  "speechLanguage": "ja",
  "baseUrl": "http://127.0.0.1:8088",
  "model": "irodori-tts",
  "apiVoice": "",
  "responseFormat": "wav",
  "apiKey": "",
  "translationEnabled": false,
  "targetLanguage": "日语",
  "translationPrompt": "",
  "translationTimeoutMs": 60000
}
```

`baseUrl` 填服务根地址或 `/v1` 前缀，不能填完整 `/v1/audio/speech` 路径。上述配置最终向 `http://127.0.0.1:8088/v1/audio/speech` 发出请求。音色留空会省略字段，不发送虚构的 `default` 或 `alloy`。配置保存与启用自动回复语音是两个独立操作；该示例直接合成日语原文，不调用翻译。需要朗读中文内容时，应选用支持中文的模型或平台；需要将中文翻译成日语时，另行开启“合成前翻译”。桥接可省略 `voice`，由服务端默认参考音色生效。人工试听音色、长文和长期稳定性尚待验收。

## 验证范围

`tests/media-providers-test.mjs` 使用隔离配置和本机模拟服务，覆盖所有平台的请求映射、密钥有无、脱敏与清除、图片 Base64/URL、任务恢复、大响应、TTS 音频、翻译、超时和取消。`tests/tts-translation-test.mjs` 验证提示词和真实 DSH 无工具会话接入，模型请求到隔离模拟服务。`tests/imagegen-ui-test.mjs` 在真实浏览器中验证配置、密钥更新、翻译设置保存、同步/异步生图和三种窗口宽度。没有配置厂商真实密钥时，这些检查不代表付费云服务已经实测，也不能代替真实 TTS 的内容验收。
