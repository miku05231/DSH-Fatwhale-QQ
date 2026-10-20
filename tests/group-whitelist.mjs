import { isAllowed, checkGroupAllowed } from '../src/security.js';
import { readFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const selfId = 1000000001;
const bot = cfg.security.allowFrom[0];
const grp = cfg.security.allowGroupIds[0];

const g = (extra) => ({ messageType: 'group', groupId: grp, userId: bot, selfId, ...extra });
const atSelf = { type: 'at', data: { qq: String(selfId) } };

const cases = [
  ['私聊 - 白名单用户', isAllowed(bot, cfg), true],
  ['私聊 - 陌生人', isAllowed(999, cfg), false],
  ['群聊 - 目标群 + @机器人', checkGroupAllowed(g({ raw: { message: [atSelf] } }), cfg), true],
  ['群聊 - 目标群 但没 @', checkGroupAllowed(g({ raw: { message: [{ type: 'text', data: { text: 'hi' } }] } }), cfg), false],
  ['群聊 - 别的群 + @机器人', checkGroupAllowed(g({ groupId: 123456, raw: { message: [atSelf] } }), cfg), false],
  ['群聊 - 目标群 + @别人', checkGroupAllowed(g({ raw: { message: [{ type: 'at', data: { qq: '10086' } }] } }), cfg), false],
];

let pass = 0;
for (const [name, actual, expected] of cases) {
  const ok = actual === expected;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (期望 ${expected}，实际 ${actual})`);
}
console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);
