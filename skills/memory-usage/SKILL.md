---
name: memory-usage
description: 记忆使用（记忆库检索与记录）。用 tools/memory.mjs 读写本机 Obsidian 长期记忆库「大肥鱼」：回答前检索人物/群聊/日志，聊到值得长期保留的事实、偏好、约定时写入。涉及"你还记得吗""上次说的""他是谁""这个群"或需要记住主人偏好时使用。
whenToUse: 用户在问过去的事、提到某个人/某个群的背景、或刚透露了值得长期保存的偏好与事实时。
---

# 记忆使用

你的长期记忆不是模型自带的，而是本机的一个 Obsidian 库 + 一个命令行工具。
**记忆库根目录**：`C:\Users\admin\Documents\Obsidian Vault\大肥鱼`

目录约定：

```
大肥鱼/
├── 10-人物/<QQ号>.md        一人一页
├── 20-群聊/<群号>.md        一群一页
├── 30-日志/YYYY-MM-DD.md    每日流水（追加式）
├── 40-知识/<标题>.md        结论、教程、学到的知识
└── 50-反思/YYYY-Www.md      阶段反思
```

## 工具

```
node C:\D\DSH\qq-bridge\tools\memory.mjs search <关键词> [--limit 8] [--json]
node C:\D\DSH\qq-bridge\tools\memory.mjs recent [--days 3] [--json]
node C:\D\DSH\qq-bridge\tools\memory.mjs person <QQ号> [--name 昵称] [--fact "…"]… [--json]
node C:\D\DSH\qq-bridge\tools\memory.mjs group <群号> [--name 群名] [--fact "…"]… [--json]
node C:\D\DSH\qq-bridge\tools\memory.mjs note --title "标题" --body "正文" [--dir 40-知识] [--tag x]… [--json]
node C:\D\DSH\qq-bridge\tools\memory.mjs daily "要记的内容" [--json]
node C:\D\DSH\qq-bridge\tools\memory.mjs stats [--json]
node C:\D\DSH\qq-bridge\tools\memory.mjs path
```

- 默认输出中文人读格式；`--json` 输出机器可读 JSON（要在代码里解析时用）。
- 退出码：0 成功 / 1 参数错误 / 2 运行错误。
- `--fact` 可以写多次，`person` / `group` 是**合并式更新**：只加事实，不会清掉旧内容。
- 正文里含空格、换行、引号时，记得用引号包好；Windows 上用双引号，内部双引号转义容易出错，尽量改用单引号或改写措辞。

## 什么时候该查

1. 用户提到"你记得吗""上次""之前说过""那个人"——先 `search` 关键词，再回答。
2. 要和某个人说话（私聊 / 被 @）——先 `person <QQ号>` 看关系、偏好、禁忌。
3. 进群发言前——`group <群号>` 看群主题、群规、群友梗。
4. 要延续上下文但会话是新的——`recent --days 2` 看最近流水。
5. 被问到"我们聊过什么""最近发生了什么"——`recent` + `search`。

检索结果是**参考**，不是圣旨：过时信息要结合当前对话判断，冲突时以用户刚说的话为准。

## 什么时候该记

**该记**（用 `daily` 记流水；稳定事实再落到 `person` / `group` / `note`）：

- 用户透露稳定的偏好、禁忌、身份、称呼（"我不吃香菜""我是做后端的"）→ `person`
- 群里定下的规矩、群主题、常用黑话 → `group`
- 得出的结论、踩过的坑、可复用的做法 → `note --dir 40-知识`
- 当天发生的值得回看的事、情绪节点、未完成承诺 → `daily`

**不该记**：

- 一次性的无信息闲聊（"哈哈哈哈""在吗"）。
- 任何密码、token、密钥、身份证号、住址等敏感信息——**绝不能写进记忆库**。
- 别人的隐私细节（除非本人明确要求记住，且确实需要）。
- 你的猜测。只记确认过的事实；不确定就标成"待确认"。

写法建议：一条事实一行，短句，别写小说。例如：

```
node C:\D\DSH\qq-bridge\tools\memory.mjs person 1000000002 --name 主人 --fact "喜欢短句，讨厌啰嗦" --fact "常用 xianapi 中转模型"
node C:\D\DSH\qq-bridge\tools\memory.mjs daily "主人让我以后回答前先查记忆库"
```

## 边界

- 记忆库工具挂了（报错、超时、找不到目录），**照常回答**，不要卡住、不要反复重试十几次；最多试一次，然后把失败如实说一句。
- 不要去改 `C:\Users\admin\Desktop\学习`（那是主人的学习笔记，禁写）。
- 不要手写整套目录结构；`memory.mjs` 会自己建。要在细节上动手，直接编辑 md 文件也行，但必须保留 YAML frontmatter（`tags` / `updated` 至少两项）和 `[[相对路径|显示名]]` 链接风格。
