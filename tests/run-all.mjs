/**
 * run-all.mjs —— 一次跑完全部测试，并把结果记账到 state/test-log/。
 *
 * 为什么要记账：用户要求「需要测试时请先记录」。所以每次跑测试都会落一份
 * Markdown + JSON 记录（时间、耗时、通过/失败、失败详情），可以事后复查，
 * 也可以交给用户自己挑时间复跑。
 *
 * 用法：
 *   node tests/run-all.mjs              # 跑全部
 *   node tests/run-all.mjs --only webui # 只跑名字里含 webui 的
 *   node tests/run-all.mjs --skip-net   # 跳过要联网/要真实 NapCat 的慢测试
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOG_DIR = path.join(ROOT, 'state', 'test-log');

const argv = process.argv.slice(2);
const onlyIndex = argv.indexOf('--only');
const only = onlyIndex >= 0 ? String(argv[onlyIndex + 1] ?? '').toLowerCase() : '';
const skipNet = argv.includes('--skip-net');

/**
 * 测试清单。order 决定执行顺序：快而纯的先跑，重的后跑。
 *  expect：从输出里必须出现的字样（没有就判失败）。
 */
const SUITE = [
  {
    name: 'onebot 协议自检',
    file: 'tests/onebot-selftest.mjs',
    expect: ['通过'],
    timeoutMs: 60_000,
    note: 'OneBot 报文解析/构造的纯函数测试',
  },
  {
    name: '群白名单',
    file: 'tests/group-whitelist.mjs',
    expect: ['通过'],
    timeoutMs: 60_000,
    note: 'allowGroupIds + @ 校验',
  },
  {
    name: '唤醒词语义',
    file: 'tests/wake-word-test.mjs',
    expect: ['通过'],
    timeoutMs: 120_000,
    note: '私聊不需唤醒词 / @ 了也不受唤醒词限制 / 没 @ 靠唤醒词搭话 / lastDrop 记录',
  },
  {
    name: '群记忆存储',
    file: 'tests/groupmem-test.mjs',
    expect: ['通过'],
    timeoutMs: 90_000,
    note: 'GroupMemory 追加/裁剪/损坏行容错',
  },
  {
    name: '模型跟随',
    file: 'tests/model-follow-test.mjs',
    expect: ['通过'],
    timeoutMs: 60_000,
    note: '桌面端补丁层解析 / runtime patch 生成与幂等 / 手动模式 / 兜底',
  },
  {
    name: 'DSH 运行模式（desktop / headless）',
    file: 'tests/agent-runner-test.mjs',
    expect: ['通过'],
    timeoutMs: 60_000,
    note: '安装根/profile 探测、auto/desktop/headless 路由、配置默认值与校验、脱敏、宿主契约',
  },
  {
    name: '桌面连伴（会话实时可见）',
    file: 'tests/companion-test.mjs',
    expect: ['通过'],
    timeoutMs: 90_000,
    note: 'discovery/鉴权/HTTP 错误语义、companion 优先路由、安装器安装与卸载、插件源码契约',
  },
  {
    name: 'DSH Web（隔离真实内核）',
    file: 'tests/dsh-web-test.mjs',
    expect: ['通过'],
    timeoutMs: 180_000,
    note: '临时 DSH_HOME、随机端口，验证真实页面/鉴权、Web 连伴权限、并行 headless 与清理',
  },
  {
    name: '管理员权限（QQ 与控制台）',
    file: 'tests/admin-access-test.mjs',
    expect: ['通过'],
    timeoutMs: 180_000,
    note: '显式管理员、可信发送人、热更新撤权、会话隔离、文本回复与管理员文件上传',
  },
  {
    name: '管理员权限（无工具聊天内核）',
    file: 'tests/admin-tool-policy-test.mjs',
    expect: ['通过'],
    timeoutMs: 180_000,
    note: '固定 DSH 内核、官方 guard、隔离假模型、多轮聊天及恶意工具调用拒绝',
  },
  {
    name: '管理员权限（桌面沙箱恢复）',
    file: 'tests/desktop-permission-test.mjs',
    expect: ['desktop permission checks'],
    timeoutMs: 90_000,
    note: '真实宿主加临时 DSH 桩，恢复旧会话后逐轮应用权限，失败关闭',
  },
  {
    name: '群成员对话权限',
    file: 'tests/group-members-test.mjs',
    expect: ['通过'],
    timeoutMs: 120_000,
    note: 'allowGroupMembers 开关：群友 @ / 喊话能不能得到回应，以及 not-allowed 时 lastDrop 可查',
  },
  {
    name: '自定义路径（人格/记忆/工作区）',
    file: 'tests/persona-test.mjs',
    expect: ['通过'],
    timeoutMs: 120_000,
    note: '路径解析（~/%VAR%/相对/绝对）+ PersonaLoader 缓存/截断/去重 + 真桥接注入人格、cwd 与记忆根',
  },
  {
    name: '黑白名单',
    file: 'tests/blacklist-test.mjs',
    expect: ['通过'],
    timeoutMs: 120_000,
    note: 'denyFrom/denyGroupIds 压过白名单、groupPolicy=allowlist 下不在名单即静默、lastDrop 原因可查',
  },
  {
    name: '插件宿主',
    file: 'tests/plugins-test.mjs',
    expect: ['通过'],
    timeoutMs: 60_000,
    note: '加载/元数据校验/开关持久化/配置合并/钩子串联与接管/抛错隔离',
  },
  {
    name: '端到端（插件）',
    file: 'tests/e2e-plugins.mjs',
    expect: ['通过'],
    timeoutMs: 120_000,
    note: '真桥接 + 假 dsh：指令插件接管且不调 dsh、afterReply 修饰最终回复',
  },
  {
    name: '模型跟随（端到端）',
    file: 'tests/e2e-model-patch.mjs',    expect: ['通过'],
    timeoutMs: 180_000,
    note: '真桥接里看 dsh argv：两条 --patch、手动优先、补丁层缺失兜底',
  },
  {
    name: '模型跟随（真 dsh 合并）',
    file: 'tests/model-patch-real-dsh.mjs',
    expect: ['通过'],
    timeoutMs: 120_000,
    note: '基础 + runtime 交给真 dsh --dump-config，确认 runtime 盖住基础 patch',
  },
  {
    name: '托盘左键目标',
    file: 'tests/tray-click-target.mjs',
    expect: ['通过'],
    timeoutMs: 120_000,
    note: '左键单击绑定 + Open-WebUiConsole 拼出的 Edge 参数（不真的点鼠标）',
  },
  {
    name: '托盘外观与退出',
    file: 'tests/tray-appearance-test.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 180_000,
    note: '隔离渲染深浅色 / 100% 与 150% 缩放 / 键盘取消 / 退出顺序，不启动真实 QQ',
  },
  {
    name: 'exe 启动器封装',
    file: 'tests/exe-host-test.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 180_000,
    note: '真实编译 / 图标与版本 / 参数引用与退出码 / 隐藏引导，全部使用隔离桩',
  },
  {
    name: '应用更新（版本与下载）',
    file: 'tests/updates-test.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 120_000,
    note: '模拟 GitHub Release、版本比较、下载来源、校验和、自动检查与安装并发',
  },
  {
    name: '应用更新（HTTP 安全）',
    file: 'tests/updates-api-test.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 60_000,
    note: '真实本机 HTTP、会话令牌、来源校验、参数白名单与确认版本',
  },
  {
    name: '应用更新（安装与回滚）',
    file: 'tests/install-update-test.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 300_000,
    note: '临时目录真实解包、保留用户数据、拒绝危险路径、失败回滚，不启动真实服务',
  },
  {
    name: '应用更新（控制台界面）',
    file: 'tests/updates-ui.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 180_000,
    note: '隔离页面交互、更新确认与重连、深浅色与三个尺寸截图，需要 Edge 与 Node 22+',
  },
  {
    name: '记忆库（Obsidian）',
    file: 'tests/memory-test.mjs',
    expect: ['通过'],
    timeoutMs: 120_000,
    note: 'ObsidianMemory 全部方法 + 检索排序 + 越界防护',
  },
  {
    name: '桥接 smoke',
    file: 'tests/smoke-test.mjs',
    expect: ['通过'],
    timeoutMs: 180_000,
    note: '会话存储 / runDsh 续传 / 超时中断',
    network: true,
  },
  {
    name: '端到端（假 NapCat）',
    file: 'tests/e2e-fake-napcat.mjs',
    expect: ['通过'],
    timeoutMs: 180_000,
    note: '私聊往返 / 白名单静默 / 会话落盘',
  },
  {
    name: '端到端（记忆写入）',
    file: 'tests/e2e-memory.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 420_000,
    note: '真跑 DSH：记忆注入 → 回复 → 落盘到 Obsidian → CLI 可检索 → 记忆库坏了能降级',
    network: true,
  },
  {
    name: '端到端（群聊）',
    file: 'tests/e2e-group.mjs',
    expect: ['通过'],
    timeoutMs: 180_000,
    note: '群里不@只记忆 / 别的群不理 / @ 才回',
  },
  {
    name: '自学习（反思）',
    file: 'tests/reflect-test.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 120_000,
    note: 'recent --json 契约 / 已存在时秒跳过 / dsh 入口解析',
  },
  {
    name: '反思定时（手动按键 + 每天定时）',
    file: 'tests/reflect-schedule-test.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 120_000,
    note: '到点一天一次 / 关机补跑 / 覆盖前备份 / 跨进程锁 / 状态记账',
  },
  {
    name: '表情包库（采集 / 标签 / 迁移 / 重建）',
    file: 'tests/stickers-test.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 180_000,
    note: '图片嗅探 / 自动标签 / 去重 / 锁 / 重建索引 / 搬家 / /api/stickers 全套',
  },
  {
    name: '表情包工具（下载 / 入库 / 旧库导入 / 提示）',
    file: 'tests/sticker-tools-test.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 120_000,
    note: '隔离配置、空库提示、图片直链下载限制、清单导入与路径校验',
  },
  {
    name: '表情发送概率（标准发送出口）',
    file: 'tests/sticker-send-policy-test.mjs',
    expect: ['通过'],
    timeoutMs: 120_000,
    note: '0 / 1 / 小数按请求抽签、CQ 与转发、库图上传、纯表情跳过及保留普通文件',
  },
  {
    name: '表情发送概率（配置与控制台）',
    file: 'tests/sticker-probability-settings-test.mjs',
    expect: ['通过'],
    timeoutMs: 120_000,
    note: '严格 0..1 数值、默认值、API 原子校验与保存',
  },
  {
    name: '多套人格（库 / 会话覆盖 / 热切换）',
    file: 'tests/personas-test.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 120_000,
    note: '名字清洗 / 建读删 / 全局与按会话选择 / 解析回退 / 坏状态自愈 / 加载器热切换 / /api/personas 全套',
  },
  {
    name: '换一台电脑（干净环境模拟）',
    file: 'tests/fresh-machine-test.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 180_000,
    note: '临时目录重装一份：控制台起得来 / 空状态接口正常 / 没 NapCat 也不崩 / 无作者路径泄漏',
  },
  {
    name: '命令行模式（start / stop / status / logs）',
    file: 'tests/cli-test.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 300_000,
    note: '临时工程里真起进程：端口可指定 / 不重复启动 / stop 停干净 / --no-console',
  },
  {
    name: '容器与三种启动方式（静态校验）',
    file: 'tests/docker-test.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 60_000,
    note: 'Dockerfile / entrypoint / compose / .env / .dockerignore / .cmd / .sh / 文档',
  },
  {
    name: '真实配置连通性',
    file: 'tests/real-config-check.mjs',
    expect: ['C:\\D\\DSH'],
    timeoutMs: 240_000,
    note: '真跑一次 dsh headless，验证 cwd 与 patch',
    network: true,
  },
  {
    name: '打开本地文件夹（隔离）',
    file: 'tests/open-path-test.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 60_000,
    note: '可见 Explorer、异步启动错误与既有打开目标；不调用真实桌面程序',
  },
  {
    name: '控制台接口',
    file: 'tests/webui-test.mjs',
    expect: ['失败 0 项'],
    timeoutMs: 180_000,
    note: '脱敏/穿越防护/全部端点/静态资源',
  },
  {
    name: '控制台界面（Edge CDP）',
    file: 'tests/ui-cdp.mjs',
    expect: ['通过'],
    timeoutMs: 240_000,
    note: '真浏览器渲染 + 点击交互 + 深色模式；控制台没起会自我跳过',
  },
  {
    name: '封装应用',
    file: 'tests/package-test.mjs',
    expect: ['通过'],
    timeoutMs: 300_000,
    note: 'tools/package.mjs 产物：必需文件在、私有物不在、脱敏干净、拷出去还能真跑测试、zip 生成',
  },
  {
    name: '公开导出',
    file: 'tests/export-public-test.mjs',
    expect: ['通过'],
    timeoutMs: 180_000,
    note: 'tools/export-public.mjs 产物：该有的在、不该有的没有、脱敏干净、自身可跑',
  },
  {
    name: '工程审计',
    file: 'tests/final-audit.mjs',
    expect: ['通过'],
    timeoutMs: 120_000,
    note: '文件齐全 / 编码 BOM / 无测试残留 / config 自洽',
  },
];

/** 跑一个 Node 脚本，返回 { code, stdout, stderr, ms } */
function runOne(file, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, file)], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err?.message ?? err), ms: Date.now() - started });
    });
  });
}

function tail(text, lines = 6) {
  const all = String(text ?? '').trimEnd().split(/\r?\n/);
  return all.slice(-lines).join('\n');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  await mkdir(LOG_DIR, { recursive: true });

  let list = SUITE;
  if (only) list = list.filter((t) => t.name.toLowerCase().includes(only) || t.file.toLowerCase().includes(only));
  if (skipNet) list = list.filter((t) => !t.network);

  if (list.length === 0) {
    console.error('没有匹配的测试');
    process.exit(2);
  }

  console.log('大肥鱼 QQ 桥接 —— 全量测试');
  console.log('='.repeat(72));

  const results = [];
  for (const item of list) {
    process.stdout.write(`▶ ${item.name} … `);
    const result = await runOne(item.file, item.timeoutMs);
    const combined = `${result.stdout}\n${result.stderr}`;
    const missing = item.expect.filter((needle) => !combined.includes(needle));
    const pass = result.code === 0 && missing.length === 0;

    results.push({
      name: item.name,
      file: item.file,
      note: item.note,
      pass,
      code: result.code,
      ms: result.ms,
      missing,
      tail: tail(combined),
      ...(!pass ? { output: combined.trimEnd() } : {}),
    });

    const icon = pass ? '通过' : '失败';
    console.log(`${icon}  ${(result.ms / 1000).toFixed(1)}s`);
    if (!pass) {
      if (result.code !== 0) console.log(`    退出码 ${result.code}`);
      if (missing.length > 0) console.log(`    缺少字样：${missing.join(' / ')}`);
      console.log(
        combined.trimEnd()
          .split('\n')
          .map((line) => `      ${line}`)
          .join('\n'),
      );
    }
  }

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);

  console.log('='.repeat(72));
  console.log(`合计 ${total} 项：通过 ${passed}，失败 ${failed}，耗时 ${(totalMs / 1000).toFixed(1)}s`);

  // ---------------------------------------------------------------- 记账
  const ts = stamp();
  const md = [];
  md.push(`# 测试记录 ${ts}`);
  md.push('');
  md.push(`- 合计：${total} 项（通过 ${passed}，失败 ${failed}）`);
  md.push(`- 总耗时：${(totalMs / 1000).toFixed(1)} 秒`);
  md.push(`- 触发方式：\`node tests/run-all.mjs ${argv.join(' ')}\``.trim());
  md.push('');
  md.push('| 结果 | 测试 | 耗时 | 说明 |');
  md.push('| --- | --- | --- | --- |');
  for (const r of results) {
    md.push(`| ${r.pass ? '通过' : '**失败**'} | ${r.name} <br>\`${r.file}\` | ${(r.ms / 1000).toFixed(1)}s | ${r.note ?? ''} |`);
  }
  if (failed > 0) {
    md.push('');
    md.push('## 失败详情');
    for (const r of results.filter((x) => !x.pass)) {
      md.push('');
      md.push(`### ${r.name}（退出码 ${r.code}）`);
      md.push('```');
      md.push(r.output || r.tail);
      md.push('```');
    }
  }
  const mdPath = path.join(LOG_DIR, `${ts}.md`);
  const jsonPath = path.join(LOG_DIR, `${ts}.json`);
  await writeFile(mdPath, `${md.join('\n')}\n`, 'utf8');
  await writeFile(jsonPath, `${JSON.stringify({ at: new Date().toISOString(), total, passed, failed, results }, null, 2)}\n`, 'utf8');

  // 顺手更新一份「最新」指针，方便快速查看
  await writeFile(path.join(LOG_DIR, 'latest.md'), `${md.join('\n')}\n`, 'utf8').catch(() => {});

  console.log(`记录已保存：${path.relative(ROOT, mdPath)}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`测试运行器崩溃：${err?.stack ?? err}`);
  process.exit(1);
});
