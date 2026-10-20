// 一次性脚手架：创建 Obsidian 记忆库骨架（可重复执行，幂等）
// 用法：node scripts\init-memory-vault.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

const VAULT = 'C:\\Users\\admin\\Documents\\Obsidian Vault';
const ROOT = path.join(VAULT, '大肥鱼');
const TODAY = new Date().toISOString().slice(0, 10);

const dirs = ['10-人物', '20-群聊', '30-日志', '40-知识', '50-反思', '.attachments'];

const writeIfAbsent = async (file, content) => {
  try {
    await fs.access(file);
    return false;
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
    return true;
  }
};

await fs.mkdir(ROOT, { recursive: true });
for (const d of dirs) await fs.mkdir(path.join(ROOT, d), { recursive: true });

const index = `---
tags: [索引, 大肥鱼]
updated: ${TODAY}
---

# 大肥鱼记忆库

QQ 里那只 DSH 鲸鱼娘的长期记忆。它自己会往里写，你也可以直接改。

## 四个抽屉

- [[10-人物/人物索引|人物]] —— 每个聊过的人一页
- [[20-群聊/群聊索引|群聊]] —— 每个群一页，记群风、常聊话题、谁是谁
- [[30-日志/日志索引|日志]] —— 每天一页流水账
- [[40-知识/知识索引|知识]] —— 学到的东西
- [[50-反思/反思索引|反思]] —— 阶段性自我总结

## 使用约定

1. 每页开头有 \`tags\`，方便在 Obsidian 里按标签筛。
2. 人物页和群聊页是「合并更新」的，同一件事别写两遍。
3. 日志是追加式，只往下写，不改历史。
4. 想让它记住什么，直接往对应页面写一句就行；下次对话它会读到。
`;

const personIndex = `---
tags: [索引, 人物]
updated: ${TODAY}
---

# 人物索引

- [[10-人物/1000000002|主人（主人）]] —— 管理员
- [[10-人物/1000000001|大肥鱼（我自己）]] —— 机器人本体
`;

const groupIndex = `---
tags: [索引, 群聊]
updated: ${TODAY}
---

# 群聊索引

- [[20-群聊/200000001|示例群]]
`;

const dailyIndex = `---
tags: [索引, 日志]
updated: ${TODAY}
---

# 日志索引

按天记录。每天一个 \`30-日志/YYYY-MM-DD.md\`。
`;

const knowledgeIndex = `---
tags: [索引, 知识]
updated: ${TODAY}
---

# 知识索引

从对话里沉淀下来的、以后还用得上的东西。
`;

const reflectIndex = `---
tags: [索引, 反思]
updated: ${TODAY}
---

# 反思索引

每周一份，记录「这一段时间我哪里做得不好、下次怎么改」。
`;

const owner = `---
tags: [人物, QQ, 管理员]
qq: 1000000002
updated: ${TODAY}
---

# 主人（主人）

- QQ：1000000002
- 关系：主人 / 管理员，唯一能直接指挥我的人
- 称呼：主人
- 偏好：说话要短、要像人、别端着；讨厌 Markdown 和长篇大论

## 相关

- [[20-群聊/200000001|示例群]]
- [[10-人物/人物索引|人物索引]]
`;

const self = `---
tags: [人物, QQ, 机器人]
qq: 1000000001
updated: ${TODAY}
---

# 大肥鱼（我自己）

- QQ：1000000001
- 身份：跑在 DSH 上的鲸鱼娘，通过 NapCat 接进 QQ
- 说话风格：傲娇、爱吃饭、会做动作描写，但正事上不胡说

## 相关

- [[10-人物/人物索引|人物索引]]
`;

const group = `---
tags: [群聊, QQ]
group: 200000001
updated: ${TODAY}
---

# 示例群

- 群号：200000001
- 人数：15
- 群风：随便聊，二次元浓度高
- 我在群里的规矩：只有被 @ 才说话

## 相关

- [[10-人物/1000000002|主人（主人）]]
- [[20-群聊/群聊索引|群聊索引]]
`;

const created = [];
for (const [file, content] of [
  ['大肥鱼.md', index],
  ['10-人物/人物索引.md', personIndex],
  ['10-人物/1000000002.md', owner],
  ['10-人物/1000000001.md', self],
  ['20-群聊/群聊索引.md', groupIndex],
  ['20-群聊/200000001.md', group],
  ['30-日志/日志索引.md', dailyIndex],
  ['40-知识/知识索引.md', knowledgeIndex],
  ['50-反思/反思索引.md', reflectIndex],
]) {
  if (await writeIfAbsent(path.join(ROOT, file), content)) created.push(file);
}

console.log(`记忆库根目录：${ROOT}`);
console.log(`目录：${dirs.join(' / ')}`);
console.log(created.length ? `新建：${created.join('、')}` : '内容已存在，未覆盖任何文件');
