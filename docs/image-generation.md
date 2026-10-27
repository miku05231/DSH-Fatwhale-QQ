# 图片生成

在控制台“表情包 → 生成 → 生图服务”选择平台，填写服务地址、模型和可选密钥并启用。支持 ComfyUI 异步接口、OpenAI、硅基流动和自定义 OpenAI 兼容接口，平台差异见 [多平台接入](media-providers.md)。

ComfyUI 异步接口使用 `POST /v1/images/generations`，服务还需提供 `/health`、返回的任务查询地址和图片下载地址。这是现有生图代理的接口，ComfyUI 原生 `/prompt` 工作流需先通过代理转换。密钥非空时，向该服务发送 `Authorization: Bearer ...`；未设置时不发送鉴权头。

管理员可直接在 QQ 提出“画一张……”或“制作一个……表情包”。DSH 会调用项目内的生图工具；桥接把生成结果交付给原来的私聊或群聊。普通成员沿用聊天权限。

普通图片保存在当前 `stateDir` 下的 `.imagegen-runtime`；表情包还会导入现有表情库，沿用 `stickers.sendProbability`。概率未命中不会换一种发图方式重发。控制台生成的图片供本机预览和下载，不主动发送 QQ 消息。

示例配置（服务地址替换为自己的地址）：

```json
{
  "imagegen": {
    "provider": "comfyui",
    "model": "",
    "apiKey": "",
    "enabled": true,
    "baseUrl": "http://127.0.0.1:8190",
    "generationPath": "/v1/images/generations",
    "timeoutMs": 240000,
    "requestTimeoutMs": 15000,
    "pollIntervalMs": 1500,
    "maxBytes": 33554432
  }
}
```

命令行：

```powershell
node tools/imagegen.mjs check --json
node tools/imagegen.mjs generate --prompt '开心的小机器人，简洁插画，白色背景' --mode sticker --tags '开心,机器人' --preset square --json
node tools/imagegen.mjs status --json
node tools/imagegen.mjs resume '任务编号' --json
```

自定义配置加 `--config '配置文件路径'`。画幅可选 `square`、`landscape`、`portrait`；支持 `--negative-prompt`。`--seed`、`--steps`、`--cfg` 适用于 ComfyUI 异步接口和硅基流动，其他平台在提交前拒绝这些参数。模型在服务设置中选择，工具不接受 `model`、`size`、`n`。ComfyUI uint64 种子以十进制字符串保存，避免精度丢失。

每个服务同时只允许一个未结束任务。异步任务可恢复轮询；同步平台收到的图片结果先存入私有运行目录，再校验并保存原图，恢复时读取缓存，不重复提交生成请求。切换平台或服务地址后须恢复原设置才能继续未完成任务。提交结果为 `unknown` 时需先检查服务端；确认任务已结束后才能在控制台解除占用，或运行 `release '任务编号' --confirmed`。停止等待不能取消服务端任务。

QQ 交付绑定当前管理员和本轮会话，撤权、取消或过期后不会自动发图。已经发起但未收到确认的发送记录保留为待确认，不自动重复发送。

任务、提示词、连接信息和原图属于私有运行数据，不会进入公开发行包。控制台任务和图片接口只允许本机访问，使用独立临时令牌；图片通过带令牌的请求获取，预览地址不携带令牌。

隔离测试：

```powershell
node --test tests/imagegen-test.mjs tests/imagegen-webui-test.mjs tests/imagegen-bridge-test.mjs
node --test tests/imagegen-ui-test.mjs
```

测试使用临时目录、模拟生图服务和模拟 QQ，不改正式配置，也不向真实 QQ 发消息。全量回归应在没有正式 `config.json` 的独立源码副本运行。
