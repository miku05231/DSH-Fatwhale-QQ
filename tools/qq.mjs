#!/usr/bin/env node
/**
 * tools/qq.mjs —— 通过 NapCat（OneBot v11）操控 QQ 的命令行工具
 *
 * 设计要点：
 *   - 零第三方依赖，纯 ESM，使用 Node ≥ 22 内置的全局 WebSocket。
 *   - 短连接：连上 → 发一条 action → 收到 echo 匹配的响应 → 关闭退出，不常驻。
 *   - 成功后 stdout 只输出 JSON（history 输出精简后的 JSON 数组），诊断信息走 stderr。
 *   - 失败（retcode != 0 或 status != ok）打印服务端返回的 message，并以 1 退出。
 *   - 单次调用（连接 + 等待响应）总超时 20 秒。
 *   - --list / --help 只读本地信息，不连接 NapCat。
 *
 * 用法：
 *   node tools/qq.mjs <action> ['<JSON 参数>']   透传任意 OneBot action
 *   node tools/qq.mjs --config <path> <action> ['<JSON 参数>']
 *   node tools/qq.mjs --list                     列出常用 action
 *   node tools/qq.mjs --help <action>            查看单个 action / 快捷命令的说明
 *   node tools/qq.mjs <快捷命令> ...             见 --list 里的【快捷命令】
 *
 * 配置：读取项目根目录 config.json 的 onebot.url 与 onebot.accessToken；
 *       读不到或格式不对时退回默认 ws://127.0.0.1:3001。
 *       --config / QQ_CONFIG 可指定配置；QQ_ONEBOT_URL / QQ_ONEBOT_TOKEN 优先于配置。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyStickerSendPolicy } from '../src/sticker-send-policy.js';

// ------------------------------------------------------------------ 常量

/** 项目根目录：tools/ 的上一级。 */
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = resolve(PROJECT_ROOT, 'config.json');
let selectedConfigPath = process.env.QQ_CONFIG ? resolve(process.env.QQ_CONFIG) : CONFIG_PATH;
let explicitConfig = Boolean(process.env.QQ_CONFIG);
const DEFAULT_WS_URL = 'ws://127.0.0.1:3001';
/** 单次调用总超时（连接 + 等待响应）。 */
const CALL_TIMEOUT_MS = 20000;
const VERSION = '1.0.0';

// ------------------------------------------------------------------ 基础工具

/** 本工具的预期错误：只打印 message，不打印堆栈。 */
class CliError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'CliError';
    Object.assign(this, extra);
  }
}

/** 写 stderr（诊断信息）。 */
function note(text) {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** 写 stdout 并在刷新后退出。 */
function output(text, code = 0) {
  process.stdout.write(text, () => process.exit(code));
}

/** 计算字符串在终端里的显示宽度（中日韩字符按 2 列算）。 */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    width += ch.codePointAt(0) > 0x2e80 ? 2 : 1;
  }
  return width;
}

/** 按显示宽度右侧补空格。 */
function padDisplay(text, width) {
  const s = String(text);
  return s + ' '.repeat(Math.max(1, width - displayWidth(s)));
}

/** 把参数拼成 JSON 文本并解析成对象。 */
function parseJsonParams(args) {
  const text = args.join(' ').trim();
  if (!text) return {};

  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new CliError(`JSON 参数解析失败：${err.message}\n收到的参数：${text}`);
  }

  if (value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError(`JSON 参数必须是一个对象，例如 {"group_id":123456789,"count":20}\n收到的参数：${text}`);
  }
  return value;
}

/** 校验并返回正整数 ID（群号 / QQ 号）。 */
function parseId(raw, label) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text) || Number(text) <= 0) {
    throw new CliError(`${label}必须是正整数，收到：${text || '（空）'}`);
  }
  return Number(text);
}

/**
 * 解析消息目标：
 *   - 纯数字            → 私聊 QQ 号
 *   - group:群号        → 群聊（也接受 群: / 群聊:）
 *   - private:QQ号      → 私聊（也接受 好友: / 私聊:）
 */
function parseTarget(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new CliError('目标不能为空');

  const matched = /^(group|群|群聊|private|friend|好友|私聊|user)[:：](\d+)$/i.exec(text);
  if (matched) {
    const kind = matched[1].toLowerCase();
    const isGroup = kind === 'group' || kind === '群' || kind === '群聊';
    // explicit=true 表示写明了是群还是私聊；纯数字时留着给调用方自己判断
    return { type: isGroup ? 'group' : 'private', id: Number(matched[2]), explicit: true };
  }

  if (/^\d+$/.test(text)) return { type: 'private', id: Number(text), explicit: false };

  throw new CliError(
    `目标格式不对：${text}\n` +
      '  私聊写 QQ 号，例如 123456789\n' +
      '  群聊写 group:群号，例如 group:123456789',
  );
}

/**
 * 把图片/文件参数归一成 NapCat 能识别的形式：
 *   - http(s):// / base64:// / file:// 原样返回
 *   - 本地路径（绝对或相对当前工作目录）转成 file:// URL
 */
function normalizeLocalMedia(raw, { mustExist = false, kind = '文件' } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) throw new CliError(`${kind}路径不能为空`);

  if (/^(https?|base64|file):\/\//i.test(text)) return text;

  const absolute = isAbsolute(text) ? text : resolve(process.cwd(), text);
  if (!existsSync(absolute)) {
    if (mustExist) throw new CliError(`${kind}文件不存在：${absolute}`);
    // 不是本地文件：可能是 NapCat 的资源 ID / QQ 内部文件名，原样交给服务端
    return text;
  }
  return pathToFileURL(absolute).href;
}

/** 时间戳（秒）转本地时间字符串。 */
function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 常见消息段 → 精简占位文字；返回 null 表示该段需要单独处理。 */
const SEGMENT_LABELS = {
  image: '[图片]',
  face: '[表情]',
  mface: '[表情]',
  marketface: '[表情]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  forward: '[聊天记录]',
  node: '[聊天记录]',
  json: '[卡片]',
  xml: '[卡片]',
  ark: '[卡片]',
  markdown: '[卡片]',
  share: '[链接]',
  music: '[音乐]',
  location: '[位置]',
  contact: '[名片]',
  poke: '[戳一戳]',
  dice: '[骰子]',
  rps: '[猜拳]',
  shake: '[窗口抖动]',
};

/** 把消息段数组拼成精简纯文本。 */
function segmentsToPlain(segments) {
  let text = '';
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') continue;
    const type = String(segment.type ?? '');
    const data = segment.data && typeof segment.data === 'object' ? segment.data : {};

    if (type === 'text') {
      if (typeof data.text === 'string') text += data.text;
      else if (data.text != null) text += String(data.text);
      continue;
    }

    if (type === 'at') {
      const qq = data.qq == null ? '' : String(data.qq);
      if (qq === 'all') text += '@全体成员';
      else if (qq) text += `@${String(data.name || qq)}`;
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(SEGMENT_LABELS, type)) {
      text += SEGMENT_LABELS[type];
      continue;
    }
    // reply 等引用类片段、未知片段：直接丢弃，保持精简
  }
  return text;
}

/** 把 CQ 码字符串转成精简纯文本（message_format=string 时使用）。 */
function cqToPlain(raw) {
  return String(raw ?? '')
    .replace(/\[CQ:image,[^\]]*\]/gi, '[图片]')
    .replace(/\[CQ:face,[^\]]*\]/gi, '[表情]')
    .replace(/\[CQ:mface,[^\]]*\]/gi, '[表情]')
    .replace(/\[CQ:record,[^\]]*\]/gi, '[语音]')
    .replace(/\[CQ:video,[^\]]*\]/gi, '[视频]')
    .replace(/\[CQ:file,[^\]]*\]/gi, '[文件]')
    .replace(/\[CQ:forward,[^\]]*\]/gi, '[聊天记录]')
    .replace(/\[CQ:json,[^\]]*\]/gi, '[卡片]')
    .replace(/\[CQ:xml,[^\]]*\]/gi, '[卡片]')
    .replace(/\[CQ:at,qq=all[^\]]*\]/gi, '@全体成员')
    .replace(/\[CQ:at,qq=([^,\]]+)(?:,name=([^\]]*))?[^\]]*\]/gi, (_m, qq, name) => `@${name || qq}`)
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

/** 从消息对象里取出精简纯文本（优先消息段数组，其次 CQ 码字符串）。 */
function extractPlainText(message) {
  const segments = message?.message;
  let text;
  if (Array.isArray(segments)) {
    text = segmentsToPlain(segments);
  } else if (typeof segments === 'string') {
    text = cqToPlain(segments);
  } else if (typeof message?.raw_message === 'string') {
    text = cqToPlain(message.raw_message);
  } else {
    text = '';
  }
  // 去掉控制字符、把换行/连续空白压成单个空格，保证一条消息一行
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 群历史消息 → 精简结构（时间 / 昵称 / QQ 号 / 纯文本）。 */
function simplifyHistory(data) {
  const messages = Array.isArray(data)
    ? data
    : Array.isArray(data?.messages)
      ? data.messages
      : [];

  return messages.map((message) => {
    const card = typeof message?.sender?.card === 'string' ? message.sender.card.trim() : '';
    const nickname = card || (typeof message?.sender?.nickname === 'string' ? message.sender.nickname.trim() : '');
    return {
      time: formatTime(message?.time),
      nickname: nickname || String(message?.user_id ?? ''),
      user_id: Number(message?.user_id ?? message?.sender?.user_id ?? 0) || 0,
      text: extractPlainText(message),
    };
  });
}

// ------------------------------------------------------------------ 配置

/** 用环境变量覆盖连接信息：QQ_ONEBOT_URL / QQ_ONEBOT_TOKEN 优先于 config.json。 */
function applyEnvOverride(base) {
  let url = base.url;
  let accessToken = base.accessToken;

  const envUrl = process.env.QQ_ONEBOT_URL;
  if (envUrl !== undefined && envUrl.trim() !== '') {
    const value = envUrl.trim();
    if (/^wss?:\/\//i.test(value)) {
      url = value;
    } else {
      note(`提示：环境变量 QQ_ONEBOT_URL 不是 ws:// 或 wss:// 地址（${value}），已忽略`);
    }
  }

  // 明确设置了这个变量就用它（包括设成空串表示无 token）
  const envToken = process.env.QQ_ONEBOT_TOKEN;
  if (envToken !== undefined) {
    accessToken = envToken.trim();
  }

  return { url, accessToken };
}

/** 读取 config.json 里的 OneBot 连接信息；任何异常都退回默认值。 */
function loadOneBotConfig() {
  let text;
  try {
    text = readFileSync(selectedConfigPath, 'utf8');
  } catch (err) {
    if (explicitConfig) throw new CliError(`读取指定 QQ 配置失败：${err.code || err.message}`);
    note(`提示：读取 ${CONFIG_PATH} 失败（${err?.code || err?.message}），改用默认地址 ${DEFAULT_WS_URL}`);
    return applyEnvOverride({ url: DEFAULT_WS_URL, accessToken: '' });
  }

  let config;
  try {
    config = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    if (explicitConfig) throw new CliError('指定 QQ 配置不是合法 JSON');
    note(`提示：${CONFIG_PATH} 不是合法 JSON（${err.message}），改用默认地址 ${DEFAULT_WS_URL}`);
    return applyEnvOverride({ url: DEFAULT_WS_URL, accessToken: '' });
  }

  const onebot = config && typeof config === 'object' ? config.onebot : null;
  let url = onebot && typeof onebot.url === 'string' && onebot.url.trim() ? onebot.url.trim() : DEFAULT_WS_URL;
  const accessToken =
    onebot && typeof onebot.accessToken === 'string' ? onebot.accessToken.trim() : '';

  // 地址必须是 ws:// 或 wss://，否则退回默认值
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      note(`提示：config.json 里的 onebot.url 不是 ws:// 或 wss:// 地址（${url}），改用默认地址 ${DEFAULT_WS_URL}`);
      url = DEFAULT_WS_URL;
    }
  } catch {
    note(`提示：config.json 里的 onebot.url 不是合法地址（${url}），改用默认地址 ${DEFAULT_WS_URL}`);
    url = DEFAULT_WS_URL;
  }

  return applyEnvOverride({ url, accessToken });
}

/** 有 accessToken 时拼到查询串上（Node 内置 WebSocket 不支持自定义请求头）。 */
function buildWsUrl(url, accessToken) {
  if (!accessToken) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('access_token')) {
      parsed.searchParams.set('access_token', accessToken);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

// ------------------------------------------------------------------ OneBot 调用

/** 把 WebSocket message 事件的 data 转成字符串。 */
function eventDataToText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return null;
}

/**
 * 短连接调用一条 OneBot action。
 * @returns {Promise<any>} 成功时返回响应里的 data
 */
async function callAction(action, params) {
  const policy = await applyStickerSendPolicy(action, params, {
    configPath: explicitConfig || existsSync(selectedConfigPath) ? selectedConfigPath : undefined,
    config: {},
    configRoot: dirname(selectedConfigPath),
  });
  if (policy.skipped) return policy.result;
  params = policy.params;
  const WebSocketImpl = globalThis.WebSocket;
  if (typeof WebSocketImpl !== 'function') {
    throw new CliError('当前 Node 没有内置 WebSocket（需要 Node ≥ 22），请升级 Node 后重试');
  }

  const { url, accessToken } = loadOneBotConfig();
  const targetUrl = buildWsUrl(url, accessToken);
  const echo = `qq-cli-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  return new Promise((resolvePromise, rejectPromise) => {
    let socket = null;
    let settled = false;

    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
          socket.close(1000, 'qq-cli done');
        }
      } catch {
        // 关闭失败不影响结果
      }
      if (error) rejectPromise(error);
      else resolvePromise(data);
    };

    const timer = setTimeout(() => {
      finish(
        new CliError(
          `调用 ${action} 超时：${CALL_TIMEOUT_MS / 1000} 秒内没有收到 NapCat 的响应。\n` +
            '  请确认 NapCat 正在运行、已登录 QQ，且 OneBot WebSocket 服务已开启。',
          { action },
        ),
      );
    }, CALL_TIMEOUT_MS);

    try {
      socket = new WebSocketImpl(targetUrl);
    } catch (err) {
      finish(
        new CliError(`无法创建到 NapCat 的 WebSocket 连接（${targetUrl}）：${err?.message || err}`, {
          action,
        }),
      );
      return;
    }

    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        finish(new CliError(`向 NapCat 发送 ${action} 请求失败：${err?.message || err}`, { action }));
      }
    });

    socket.addEventListener('message', (event) => {
      const text = eventDataToText(event?.data);
      if (text === null) return;

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return; // 非 JSON 数据（如心跳文本）直接忽略
      }

      if (!payload || typeof payload !== 'object' || String(payload.echo) !== echo) return;

      const retcode = payload.retcode;
      const status = payload.status;
      const retcodeBad = retcode !== undefined && retcode !== null && Number(retcode) !== 0;
      const statusBad = status !== undefined && status !== null && status !== 'ok';

      if (retcodeBad || statusBad) {
        const detail =
          payload.message || payload.wording || payload.msg || '（服务端没有返回错误描述）';
        const meta = [];
        if (retcode !== undefined && retcode !== null) meta.push(`retcode=${retcode}`);
        if (status !== undefined && status !== null) meta.push(`status=${status}`);
        finish(
          new CliError(
            `调用 ${action} 失败：${detail}${meta.length ? `（${meta.join('，')}）` : ''}`,
            { action, retcode, response: payload },
          ),
        );
        return;
      }

      finish(null, payload.data);
    });

    socket.addEventListener('error', () => {
      // 连接阶段出错：给出可操作的中文提示；已连上后的错误交给 close 统一处理
      if (socket && socket.readyState !== 1) {
        finish(
          new CliError(
            `无法连接 NapCat（${targetUrl}）。\n` +
              '  请确认 NapCat 已启动、QQ 已登录，且 OneBot WebSocket 服务监听在该地址。',
            { action },
          ),
        );
      }
    });

    socket.addEventListener('close', (event) => {
      if (settled) return;
      const code = event?.code;
      const reason = event?.reason ? `，${event.reason}` : '';
      finish(
        new CliError(
          `与 NapCat 的连接在收到响应前断开（code=${code}${reason}）。\n` +
            '  请确认 NapCat 没有崩溃或重启。',
          { action },
        ),
      );
    });
  });
}

// ------------------------------------------------------------------ action 目录
//
// params 里的每一项：[参数名, 说明]。仅用于 --list / --help 的展示。

const ACTIONS = {
  // ---------------- 消息 ----------------
  send_msg: {
    desc: '发送消息（私聊/群聊通用）',
    params: [
      ['message_type', '"private"（私聊）或 "group"（群聊）'],
      ['user_id', '私聊目标 QQ 号（message_type=private 时必填）'],
      ['group_id', '群聊目标群号（message_type=group 时必填）'],
      ['message', '消息内容：字符串或消息段数组'],
      ['auto_escape', '可选，true 表示按纯文本发送、不解析 CQ 码'],
    ],
    example:
      'node tools/qq.mjs send_msg \'{"message_type":"group","group_id":123456789,"message":"你好"}\'',
  },
  send_private_msg: {
    desc: '发送私聊消息',
    params: [
      ['user_id', '目标 QQ 号'],
      ['message', '消息内容：字符串或消息段数组'],
      ['auto_escape', '可选，true 表示不解析 CQ 码'],
    ],
    example:
      'node tools/qq.mjs send_private_msg \'{"user_id":123456789,"message":"你好"}\'',
  },
  send_group_msg: {
    desc: '发送群消息',
    params: [
      ['group_id', '群号'],
      ['message', '消息内容：字符串或消息段数组'],
      ['auto_escape', '可选，true 表示不解析 CQ 码'],
    ],
    example:
      'node tools/qq.mjs send_group_msg \'{"group_id":123456789,"message":"你好"}\'',
  },
  delete_msg: {
    desc: '撤回消息',
    params: [['message_id', '消息 ID（来自消息事件或 get_msg）']],
  },
  get_msg: {
    desc: '按消息 ID 获取消息详情',
    params: [['message_id', '消息 ID']],
  },
  send_group_forward_msg: {
    desc: '发送群聊合并转发消息',
    params: [
      ['group_id', '群号'],
      ['messages', '节点数组，每个节点形如 {"type":"node","data":{"user_id":1,"nickname":"昵称","content":[{"type":"text","data":{"text":"内容"}}]}}'],
    ],
  },
  get_forward_msg: {
    desc: '获取合并转发消息的详细内容',
    params: [['message_id', '合并转发消息的 ID']],
  },

  // ---------------- 群管理 ----------------
  set_group_ban: {
    desc: '禁言群成员（duration=0 解除禁言）',
    params: [
      ['group_id', '群号'],
      ['user_id', '被禁言成员 QQ 号'],
      ['duration', '禁言秒数，0 表示解除（默认 0）'],
    ],
    example:
      'node tools/qq.mjs set_group_ban \'{"group_id":123456789,"user_id":123456,"duration":600}\'',
  },
  set_group_whole_ban: {
    desc: '开启/关闭群全员禁言',
    params: [
      ['group_id', '群号'],
      ['enable', 'true 开启，false 关闭'],
    ],
  },
  set_group_kick: {
    desc: '把成员踢出群',
    params: [
      ['group_id', '群号'],
      ['user_id', '成员 QQ 号'],
      ['reject_add_request', '可选，true 表示同时拒绝其再加群'],
    ],
  },
  set_group_card: {
    desc: '设置群名片（card 传空字符串可清除）',
    params: [
      ['group_id', '群号'],
      ['user_id', '成员 QQ 号'],
      ['card', '新群名片'],
    ],
  },
  set_group_admin: {
    desc: '设置/取消群管理员',
    params: [
      ['group_id', '群号'],
      ['user_id', '成员 QQ 号'],
      ['enable', 'true 设为管理员，false 取消'],
    ],
  },
  set_group_name: {
    desc: '修改群名称',
    params: [
      ['group_id', '群号'],
      ['group_name', '新群名称'],
    ],
  },
  set_group_leave: {
    desc: '退出群（群主可解散）',
    params: [
      ['group_id', '群号'],
      ['is_dismiss', '可选，true 表示解散群（仅群主）'],
    ],
  },
  set_group_special_title: {
    desc: '设置群成员专属头衔',
    params: [
      ['group_id', '群号'],
      ['user_id', '成员 QQ 号'],
      ['special_title', '专属头衔，空字符串表示取消'],
    ],
  },
  get_group_info: {
    desc: '获取群基本信息',
    params: [['group_id', '群号']],
  },
  get_group_list: {
    desc: '获取机器人加入的群列表',
    params: [['no_cache', '可选，true 表示强制刷新缓存']],
  },
  get_group_member_list: {
    desc: '获取群成员列表',
    params: [
      ['group_id', '群号'],
      ['no_cache', '可选，true 表示强制刷新缓存'],
    ],
  },
  get_group_member_info: {
    desc: '获取单个群成员的详细信息',
    params: [
      ['group_id', '群号'],
      ['user_id', '成员 QQ 号'],
      ['no_cache', '可选，true 表示强制刷新缓存'],
    ],
  },
  get_group_msg_history: {
    desc: '获取群历史消息',
    params: [
      ['group_id', '群号'],
      ['count', '获取条数（默认 20）'],
      ['message_seq', '可选，起始消息序号'],
      ['reverse_order', '可选，true 表示反向排序'],
    ],
    example:
      'node tools/qq.mjs get_group_msg_history \'{"group_id":123456789,"count":20}\'',
  },
  get_group_honor_info: {
    desc: '获取群荣誉信息（龙王、群聊之火等）',
    params: [
      ['group_id', '群号'],
      ['type', '可选：all / current_talkative / talkative / performer / legend / strong_newbie / emotion，默认 all'],
    ],
  },
  get_group_shut_list: {
    desc: '获取群当前被禁言成员列表',
    params: [['group_id', '群号']],
  },
  set_group_sign: {
    desc: '群打卡',
    params: [['group_id', '群号']],
  },
  send_group_notice: {
    desc: '发送群公告',
    params: [
      ['group_id', '群号'],
      ['content', '公告正文'],
      ['image', '可选，公告图片：本地路径 / URL / base64'],
      ['pinned', '可选，0 不置顶、1 置顶（默认 0）'],
    ],
  },
  get_group_notice: {
    desc: '获取群公告列表',
    params: [['group_id', '群号']],
  },

  // ---------------- 好友 ----------------
  get_friend_list: {
    desc: '获取好友列表',
    params: [['no_cache', '可选，true 表示强制刷新缓存']],
  },
  get_stranger_info: {
    desc: '获取陌生人信息',
    params: [
      ['user_id', '目标 QQ 号'],
      ['no_cache', '可选，true 表示强制刷新缓存'],
    ],
  },
  set_friend_remark: {
    desc: '设置好友备注',
    params: [
      ['user_id', '好友 QQ 号'],
      ['remark', '新备注'],
    ],
  },
  send_like: {
    desc: '给好友点赞',
    params: [
      ['user_id', '好友 QQ 号'],
      ['times', '点赞次数'],
    ],
  },
  delete_friend: {
    desc: '删除好友',
    params: [
      ['user_id', '好友 QQ 号'],
      ['temp_block', '可选，true 表示同时加入黑名单'],
      ['temp_both_del', '可选，true 表示双向删除'],
    ],
  },

  // ---------------- QQ 空间 ----------------
  send_qzone_msg: {
    desc: '发表 QQ 空间说说（支持多图与可见范围）',
    params: [
      ['content', '说说正文'],
      ['images', '可选，图片数组，支持 file:// / http(s):// / base64://'],
      ['ugc_right', '可选，可见范围：1 所有人 / 4 好友 / 16 部分好友 / 64 仅自己 / 128 部分好友不可见（默认 1）'],
      ['target_uins', '可选，ugc_right 为 16 或 128 时生效的 QQ 号数组'],
    ],
    example:
      'node tools/qq.mjs send_qzone_msg \'{"content":"今天天气不错","ugc_right":1}\'',
  },
  delete_qzone_msg: {
    desc: '删除 QQ 空间说说',
    params: [['tid', '说说 tid（来自 send_qzone_msg 或 get_qzone_msg_list）']],
    example: 'node tools/qq.mjs delete_qzone_msg \'{"tid":"xxxx"}\'',
  },

  // ---------------- 账号 ----------------
  get_login_info: {
    desc: '获取机器人自己的账号信息',
    params: [],
  },
  get_status: {
    desc: '获取 NapCat / 机器人在线状态',
    params: [],
  },
  set_qq_profile: {
    desc: '修改机器人昵称、个性签名等资料',
    params: [
      ['nickname', '新昵称'],
      ['personal_note', '个性签名'],
      ['sex', '性别：0 未知 / 1 男 / 2 女'],
    ],
  },
  set_online_status: {
    desc: '设置机器人在线状态',
    params: [
      ['status', '状态码：10 在线 / 30 离开 / 40 隐身 / 50 忙碌 / 60 Q我吧 / 70 请勿打扰'],
      ['ext_status', '扩展状态码，普通状态填 0'],
      ['battery_status', '电量，普通状态填 0'],
    ],
  },
  set_long_nick: {
    desc: '设置机器人个性签名',
    params: [['longNick', '个性签名内容（注意是驼峰命名）']],
  },
  get_online_clients: {
    desc: '获取当前在线客户端列表（部分 NapCat 版本返回空数组）',
    params: [],
  },

  // ---------------- 媒体 ----------------
  get_image: {
    desc: '获取图片文件信息与下载地址',
    params: [['file', '图片文件名 / 资源 ID']],
  },
  get_record: {
    desc: '获取语音文件，可转格式',
    params: [
      ['file', '可选，语音文件路径 / URL / base64'],
      ['file_id', '可选，语音文件 ID'],
      ['out_format', '输出格式，如 mp3 / wav / amr / silk 等'],
    ],
  },
  get_file: {
    desc: '获取文件信息与下载地址',
    params: [['file_id', '文件 ID']],
  },
  upload_group_file: {
    desc: '上传文件到群文件',
    params: [
      ['group_id', '群号'],
      ['file', '本地路径 / URL'],
      ['name', '上传后的文件名'],
      ['folder', '可选，目标文件夹 ID'],
    ],
  },
  upload_private_file: {
    desc: '上传文件到私聊',
    params: [
      ['user_id', '目标 QQ 号'],
      ['file', '本地路径 / URL'],
      ['name', '上传后的文件名'],
    ],
  },
  get_group_file_url: {
    desc: '获取群文件的下载链接',
    params: [
      ['group_id', '群号'],
      ['file_id', '群文件 ID'],
    ],
  },

  // ---------------- 系统 ----------------
  get_version_info: {
    desc: '获取 NapCat 版本信息',
    params: [],
  },
  get_robot_uids: {
    desc: '获取机器人 UID 列表（部分 NapCat 版本未实现）',
    params: [],
  },
  clean_cache: {
    desc: '清理 NapCat 临时文件与缓存（会删文件）',
    params: [],
  },
};

/** --list 的分组与顺序；一个 action 可以出现在多个分组里。 */
const LIST_GROUPS = [
  {
    name: '消息',
    actions: [
      'send_msg',
      'send_private_msg',
      'send_group_msg',
      'delete_msg',
      'get_msg',
      'send_group_forward_msg',
      'get_forward_msg',
    ],
  },
  {
    name: '群管理',
    actions: [
      'set_group_ban',
      'set_group_whole_ban',
      'set_group_kick',
      'set_group_card',
      'set_group_admin',
      'set_group_name',
      'set_group_leave',
      'set_group_special_title',
      'get_group_info',
      'get_group_list',
      'get_group_member_list',
      'get_group_member_info',
      'get_group_msg_history',
      'get_group_honor_info',
      'get_group_shut_list',
      'set_group_sign',
      'send_group_notice',
      'get_group_notice',
    ],
  },
  {
    name: '好友',
    actions: [
      'get_friend_list',
      'get_stranger_info',
      'set_friend_remark',
      'send_like',
      'delete_friend',
    ],
  },
  {
    name: 'QQ空间',
    actions: ['send_qzone_msg', 'delete_qzone_msg'],
  },
  {
    name: '账号',
    actions: [
      'get_login_info',
      'get_status',
      'set_qq_profile',
      'set_online_status',
      'set_long_nick',
      'get_online_clients',
    ],
  },
  {
    name: '媒体',
    actions: [
      'get_image',
      'get_record',
      'get_file',
      'upload_group_file',
      'upload_private_file',
      'get_group_file_url',
    ],
  },
  {
    name: '系统',
    actions: ['get_version_info', 'get_status', 'get_robot_uids', 'clean_cache'],
  },
];

// ------------------------------------------------------------------ 快捷命令

/** 校验 --right 参数。 */
function parseUgcRight(raw) {
  const text = String(raw ?? '').trim();
  if (!['1', '4', '16', '64', '128'].includes(text)) {
    throw new CliError(`--right 只能是 1、4、16、64、128，收到：${text || '（空）'}`);
  }
  return Number(text);
}

/** 校验 --to 参数：逗号分隔的 QQ 号。 */
function parseTargetUins(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new CliError('--to 需要一个用逗号分隔的 QQ 号列表');
  const parts = text
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new CliError('--to 需要一个用逗号分隔的 QQ 号列表');
  return parts.map((item) => parseId(item, 'QQ 号'));
}

/** 快捷命令定义：run() 返回 { action, params, post? }。 */
const SUGAR = {
  send: {
    usage: 'send <target> <文本>',
    desc: '发送文本消息（换行原样保留）',
    notes: [
      'target 为 QQ 号时发私聊；写成 group:群号 时发群聊。',
      '正文里的 @昵称、emoji、换行都按原样发送，不做特殊处理。',
    ],
    example: 'node tools/qq.mjs send group:123456789 "你好，世界"',
    run(args) {
      if (args.length < 2) {
        throw new CliError('用法：send <target> <文本>\n例如：node tools/qq.mjs send group:123456789 "你好"');
      }
      const target = parseTarget(args[0]);
      const text = args.slice(1).join(' ');
      if (!text) throw new CliError('消息内容不能为空');

      const message = [{ type: 'text', data: { text } }];
      return target.type === 'group'
        ? { action: 'send_group_msg', params: { group_id: target.id, message } }
        : { action: 'send_private_msg', params: { user_id: target.id, message } };
    },
  },

  image: {
    usage: 'image <target> <本地路径或URL>',
    desc: '发送图片（本地路径自动转成 file://）',
    notes: [
      'target 规则与 send 相同：QQ 号=私聊，group:群号=群聊。',
      '本地相对路径按当前工作目录解析；http(s):// 与 base64:// 原样传给 NapCat。',
    ],
    example: 'node tools/qq.mjs image group:123456789 "C:/图片/test.png"',
    run(args) {
      if (args.length < 2) {
        throw new CliError('用法：image <target> <本地路径或URL>\n例如：node tools/qq.mjs image group:123456789 "C:/图片/test.png"');
      }
      const target = parseTarget(args[0]);
      const file = normalizeLocalMedia(args.slice(1).join(' ').trim(), {
        mustExist: true,
        kind: '图片',
      });
      const message = [{ type: 'image', data: { file } }];
      return target.type === 'group'
        ? { action: 'send_group_msg', params: { group_id: target.id, message } }
        : { action: 'send_private_msg', params: { user_id: target.id, message } };
    },
  },

  recall: {
    usage: 'recall <message_id>',
    desc: '撤回消息',
    notes: ['message_id 来自消息事件、get_msg 或 send 的返回值。'],
    example: 'node tools/qq.mjs recall 123456789',
    run(args) {
      const id = String(args[0] ?? '').trim();
      if (!id) throw new CliError('用法：recall <message_id>');
      if (!/^\d+$/.test(id)) throw new CliError(`消息 ID 应该是纯数字，收到：${id}`);
      return { action: 'delete_msg', params: { message_id: id } };
    },
  },

  me: {
    usage: 'me',
    desc: '查看机器人自己的账号与昵称',
    notes: ['等价于 get_login_info。'],
    example: 'node tools/qq.mjs me',
    run() {
      return { action: 'get_login_info', params: {} };
    },
  },

  friends: {
    usage: 'friends',
    desc: '获取好友列表',
    notes: ['等价于 get_friend_list，输出好友对象的完整字段。'],
    example: 'node tools/qq.mjs friends',
    run() {
      return { action: 'get_friend_list', params: {} };
    },
  },

  groups: {
    usage: 'groups',
    desc: '获取机器人加入的群列表',
    notes: ['等价于 get_group_list，输出群对象的完整字段。'],
    example: 'node tools/qq.mjs groups',
    run() {
      return { action: 'get_group_list', params: {} };
    },
  },

  members: {
    usage: 'members <group_id>',
    desc: '获取群成员列表',
    notes: ['等价于 get_group_member_list。'],
    example: 'node tools/qq.mjs members 123456789',
    run(args) {
      const groupId = parseId(args[0], '群号');
      return { action: 'get_group_member_list', params: { group_id: groupId } };
    },
  },

  history: {
    usage: 'history <QQ号或群号> [条数]',
    desc: '读取聊天记录（精简格式，默认 20 条；自动区分群聊与私聊）',
    notes: [
      '纯数字时先查一遍群列表：是机器人所在的群就读群历史，否则读好友私聊历史。',
      '也可以显式写 group:群号 或 user:QQ号，跳过自动判断。',
      '条数省略时为 20，允许 1–200。',
      '输出 JSON 数组，每项只有 time / nickname / user_id / text 四个字段。',
      '图片显示为 [图片]，表情显示为 [表情]，CQ 码和图片 URL 会被清除。',
    ],
    example: 'node tools/qq.mjs history 123456789 5',
    run(args) {
      if (!args[0]) throw new CliError('用法：history <QQ号或群号> [条数]');
      const target = parseTarget(args[0]);

      let count = 20;
      if (args[1] !== undefined) {
        if (!/^\d+$/.test(String(args[1]).trim())) {
          throw new CliError(`条数必须是正整数，收到：${args[1]}`);
        }
        count = Number(args[1]);
        if (count < 1 || count > 200) throw new CliError('条数必须在 1 到 200 之间');
      }

      // 群聊和私聊的 action 名、参数名都不一样，这里统一收口
      const build = (type) => ({
        action: type === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history',
        params: type === 'group' ? { group_id: target.id, count } : { user_id: target.id, count },
        post(data) {
          const list = simplifyHistory(data);
          const where = type === 'group' ? '群' : '私聊';
          note(
            list.length > 0
              ? `已获取 ${list.length} 条${where}历史消息（图片/表情已转成占位文字）`
              : `没有取到${where}历史消息`,
          );
          return list;
        },
      });

      if (target.explicit) return build(target.type);

      // 纯数字分不清是群号还是 QQ 号：先查一次群列表再决定
      return {
        before() {
          return {
            action: 'get_group_list',
            params: {},
            resolve(groups) {
              const list = Array.isArray(groups) ? groups : [];
              const hit = list.some((item) => Number(item?.group_id) === target.id);
              return build(hit ? 'group' : 'private');
            },
          };
        },
      };
    },
  },

  qzone: {
    usage: 'qzone <正文> [--image <路径>]... [--right <1|4|16|64|128>] [--to <QQ号,QQ号>]',
    desc: '发表 QQ 空间说说（默认仅自己可见）',
    notes: [
      '默认 ugc_right=64（仅自己可见）；确认没问题后再用 qzone-public 公开发布。',
      '--image 可以写多次；本地路径会自动转成 file://，支持 http(s):// 与 base64://。',
      '--right 显式指定可见范围：1 所有人、4 好友、16 部分好友、64 仅自己、128 部分好友不可见。',
      '--right 为 16 或 128 时必须用 --to 指定 QQ 号（逗号分隔）。',
      '正文可以用引号包住多行内容。',
    ],
    example:
      'node tools/qq.mjs qzone "今天天气不错" --image "C:/图片/a.png" --right 4',
    run(args) {
      const contentParts = [];
      const images = [];
      let ugcRight = 64;
      let targetUins = [];

      for (let i = 0; i < args.length; i += 1) {
        const item = args[i];

        if (item === '--image' || item === '-i') {
          const value = args[i + 1];
          if (value === undefined) throw new CliError('--image 后面要跟图片路径或 URL');
          images.push(normalizeLocalMedia(value, { mustExist: true, kind: '图片' }));
          i += 1;
          continue;
        }
        if (item.startsWith('--image=')) {
          images.push(normalizeLocalMedia(item.slice('--image='.length), { mustExist: true, kind: '图片' }));
          continue;
        }

        if (item === '--right' || item === '-r') {
          if (args[i + 1] === undefined) throw new CliError('--right 后面要跟 1、4、16、64、128');
          ugcRight = parseUgcRight(args[i + 1]);
          i += 1;
          continue;
        }
        if (item.startsWith('--right=')) {
          ugcRight = parseUgcRight(item.slice('--right='.length));
          continue;
        }

        if (item === '--to' || item === '-t') {
          if (args[i + 1] === undefined) throw new CliError('--to 后面要跟逗号分隔的 QQ 号列表');
          targetUins = parseTargetUins(args[i + 1]);
          i += 1;
          continue;
        }
        if (item.startsWith('--to=')) {
          targetUins = parseTargetUins(item.slice('--to='.length));
          continue;
        }

        if (item === '--') {
          contentParts.push(...args.slice(i + 1));
          break;
        }
        if (item.startsWith('--')) {
          throw new CliError(`未知选项：${item}\n可用选项：--image / --right / --to`);
        }

        contentParts.push(item);
      }

      const content = contentParts.join(' ').trim();
      if (!content && images.length === 0) {
        throw new CliError('说说正文不能为空。用法：qzone <正文> [--image <路径>]...');
      }
      if ((ugcRight === 16 || ugcRight === 128) && targetUins.length === 0) {
        throw new CliError('--right 为 16 或 128 时，必须用 --to 指定 QQ 号');
      }

      const params = { content, ugc_right: ugcRight };
      if (images.length > 0) params.images = images;
      if (targetUins.length > 0) params.target_uins = targetUins;

      return { action: 'send_qzone_msg', params };
    },
  },

  'qzone-del': {
    usage: 'qzone-del <tid>',
    desc: '删除一条 QQ 空间说说',
    notes: ['tid 来自 send_qzone_msg 的返回值或 get_qzone_msg_list。'],
    example: 'node tools/qq.mjs qzone-del xxxxxxxx',
    run(args) {
      const tid = String(args[0] ?? '').trim();
      if (!tid) throw new CliError('用法：qzone-del <tid>');
      return { action: 'delete_qzone_msg', params: { tid } };
    },
  },

  'qzone-public': {
    usage: 'qzone-public <正文> [--image <路径>]... [--to <QQ号,QQ号>]',
    desc: '发表公开的 QQ 空间说说（所有人可见）',
    notes: [
      '等价于 qzone --right 1，即 ugc_right=1。',
      '其余选项与 qzone 完全相同；正文以 -- 开头时用 -- 分隔。',
    ],
    example: 'node tools/qq.mjs qzone-public "今天天气不错"',
    run(args) {
      // 复用 qzone 的选项解析：在最前面塞一个 --right 1 覆盖它的默认值 64
      return SUGAR.qzone.run(['--right', '1', ...args]);
    },
  },

  nick: {
    usage: 'nick <昵称> | nick <QQ号> <备注> | nick <群号> <QQ号> <名片>',
    desc: '改机器人昵称 / 好友备注 / 群名片（按参数个数区分）',
    notes: [
      'nick 新昵称 → set_qq_profile，改机器人自己的昵称。',
      'nick QQ号 备注 → set_friend_remark，改好友备注。',
      'nick 群号 QQ号 名片 → set_group_card，改群名片。',
      '昵称/备注里带空格时用引号包起来；备注传空字符串可清除。',
    ],
    example: 'node tools/qq.mjs nick 123456789 "老同学"',
    run(args) {
      if (args.length === 0) {
        throw new CliError('用法：nick <昵称> | nick <QQ号> <备注> | nick <群号> <QQ号> <名片>');
      }

      if (args.length === 1) {
        const nickname = String(args[0]).trim();
        if (!nickname) throw new CliError('昵称不能为空');
        return { action: 'set_qq_profile', params: { nickname } };
      }

      if (args.length === 2) {
        const userId = parseId(args[0], 'QQ 号');
        const remark = args.slice(1).join(' ').trim();
        return { action: 'set_friend_remark', params: { user_id: userId, remark } };
      }

      const groupId = parseId(args[0], '群号');
      const userId = parseId(args[1], 'QQ 号');
      const card = args.slice(2).join(' ');
      return { action: 'set_group_card', params: { group_id: groupId, user_id: userId, card } };
    },
  },

  ban: {
    usage: 'ban <group_id> <user_id> [秒数]',
    desc: '禁言群成员（默认 600 秒，0 解除）',
    notes: ['等价于 set_group_ban；秒数省略时为 600。'],
    example: 'node tools/qq.mjs ban 123456789 123456 600',
    run(args) {
      if (args.length < 2) {
        throw new CliError('用法：ban <group_id> <user_id> [秒数]');
      }
      const groupId = parseId(args[0], '群号');
      const userId = parseId(args[1], 'QQ 号');
      let duration = 600;
      if (args[2] !== undefined) {
        const text = String(args[2]).trim();
        if (!/^\d+$/.test(text)) throw new CliError(`禁言秒数必须是非负整数，收到：${args[2]}`);
        duration = Number(text);
      }
      return { action: 'set_group_ban', params: { group_id: groupId, user_id: userId, duration } };
    },
  },

  kick: {
    usage: 'kick <群号> <QQ号> [true|false]',
    desc: '把成员踢出群（第三个参数 true 表示同时拒绝再加群）',
    notes: [
      '等价于 set_group_kick；机器人必须是管理员或群主，否则会被服务端拒绝。',
      '默认只踢人、不拒绝再加群；写 true 才会一并拒绝。',
    ],
    example: 'node tools/qq.mjs kick 123456789 123456',
    run(args) {
      if (args.length < 2) {
        throw new CliError('用法：kick <群号> <QQ号> [true|false]');
      }
      const groupId = parseId(args[0], '群号');
      const userId = parseId(args[1], 'QQ 号');
      const params = { group_id: groupId, user_id: userId };

      if (args[2] !== undefined) {
        const flag = String(args[2]).trim().toLowerCase();
        if (flag === 'true' || flag === '1') params.reject_add_request = true;
        else if (flag === 'false' || flag === '0') params.reject_add_request = false;
        else throw new CliError(`第三个参数只能是 true 或 false，收到：${args[2]}`);
      }

      return { action: 'set_group_kick', params };
    },
  },

  poke: {
    usage: 'poke <QQ号> | poke group:<群号> <QQ号>',
    desc: '戳一戳（私聊或群内）',
    notes: [
      'poke 123456789 表示私聊戳该 QQ。',
      'poke group:123456789 123456 表示在群里戳某个成员。',
      '也支持把群目标写在第二个参数：poke 123456 group:123456789。',
    ],
    example: 'node tools/qq.mjs poke group:123456789 123456',
    run(args) {
      if (!args[0]) {
        throw new CliError('用法：poke <QQ号> 或 poke group:<群号> <QQ号>');
      }
      const first = parseTarget(args[0]);

      if (args[1] !== undefined) {
        if (first.type === 'group') {
          const userId = parseId(args[1], 'QQ 号');
          return { action: 'group_poke', params: { group_id: first.id, user_id: userId } };
        }
        const second = parseTarget(args[1]);
        if (second.type === 'group') {
          return { action: 'group_poke', params: { group_id: second.id, user_id: first.id } };
        }
        throw new CliError('群内戳一戳的写法是：poke group:<群号> <QQ号>');
      }

      if (first.type === 'group') {
        throw new CliError('群内戳一戳还要指定 QQ 号：poke group:<群号> <QQ号>');
      }
      return { action: 'friend_poke', params: { user_id: first.id } };
    },
  },
};

// ------------------------------------------------------------------ 帮助与列表

/** prints --list 内容。 */
function printList() {
  const lines = [];
  lines.push(`QQ 操控工具 v${VERSION}（NapCat / OneBot v11）`);
  lines.push('');
  lines.push('用法：');
  lines.push('  node tools/qq.mjs <action> [\'<JSON 参数>\']   透传任意 OneBot action');
  lines.push('  node tools/qq.mjs --list                      列出常用 action');
  lines.push('  node tools/qq.mjs --help <action>             查看单个 action 的参数说明');
  lines.push('  node tools/qq.mjs <快捷命令> ...              见下方【快捷命令】');
  lines.push('');
  lines.push('常用 action：');

  for (const group of LIST_GROUPS) {
    lines.push('');
    lines.push(`【${group.name}】`);
    for (const name of group.actions) {
      const action = ACTIONS[name];
      if (!action) continue;
      lines.push(`  ${padDisplay(name, 28)}${action.desc}`);
    }
  }

  lines.push('');
  lines.push('【快捷命令】');
  const sugarSpecs = Object.values(SUGAR);
  // 按最长用法动态对齐；过长的用法改为下一行显示说明，避免把整列撑得太宽
  const sugarWidth = Math.min(
    Math.max(...sugarSpecs.map((spec) => displayWidth(spec.usage))) + 2,
    64,
  );
  for (const spec of sugarSpecs) {
    if (displayWidth(spec.usage) >= sugarWidth) {
      lines.push(`  ${spec.usage}`);
      lines.push(`      ${spec.desc}`);
    } else {
      lines.push(`  ${padDisplay(spec.usage, sugarWidth)}${spec.desc}`);
    }
  }

  lines.push('');
  lines.push('提示：');
  lines.push('  - 成功时 stdout 只输出 JSON；诊断信息、进度提示走 stderr。');
  lines.push('  - 任何 OneBot action 都可以透传，不限于上面的清单。');
  lines.push('  - 例：node tools/qq.mjs get_group_msg_history \'{"group_id":123456789,"count":20}\'');
  lines.push('  - 修改类命令请先确认对象，避免误操作。');

  output(`${lines.join('\n')}\n`);
}

/** 打印单个 action 的帮助。 */
function printActionHelp(name) {
  const action = ACTIONS[name];
  const lines = [];
  lines.push(`${name} — ${action.desc}`);
  lines.push('');
  lines.push('用法：');
  lines.push(`  node tools/qq.mjs ${name} '<JSON 参数>'`);
  lines.push('');

  if (action.params.length === 0) {
    lines.push('参数：无（可省略 JSON，或传 {}）');
  } else {
    lines.push('参数（JSON 对象）：');
    for (const [key, desc] of action.params) {
      lines.push(`  ${padDisplay(key, 20)}${desc}`);
    }
  }

  lines.push('');
  lines.push('示例：');
  lines.push(`  ${action.example || `node tools/qq.mjs ${name} '{}'`}`);

  output(`${lines.join('\n')}\n`);
}

/** 打印快捷命令帮助。 */
function printSugarHelp(name) {
  const spec = SUGAR[name];
  const lines = [];
  lines.push(`${name} — ${spec.desc}`);
  lines.push('');
  lines.push('用法：');
  lines.push(`  node tools/qq.mjs ${spec.usage}`);
  if (spec.notes && spec.notes.length > 0) {
    lines.push('');
    lines.push('说明：');
    for (const item of spec.notes) lines.push(`  - ${item}`);
  }
  if (spec.example) {
    lines.push('');
    lines.push('示例：');
    lines.push(`  ${spec.example}`);
  }
  output(`${lines.join('\n')}\n`);
}

/** 打印总用法。 */
function printUsage() {
  const lines = [
    `QQ 操控工具 v${VERSION}（NapCat / OneBot v11）`,
    '',
    '用法：',
    '  node tools/qq.mjs <action> [\'<JSON 参数>\']   透传任意 OneBot action',
    '  node tools/qq.mjs --config <path> <action>    使用指定配置（读取失败时停止）',
    '  node tools/qq.mjs --list                      列出常用 action',
    '  node tools/qq.mjs --help <action>             查看单个 action 的参数说明',
    '  node tools/qq.mjs <快捷命令> ...              例如 send / history / qzone',
    '',
    '示例：',
    '  node tools/qq.mjs me',
    '  node tools/qq.mjs history 123456789 5',
    '  node tools/qq.mjs send group:123456789 "你好"',
    '  node tools/qq.mjs get_group_msg_history \'{"group_id":123456789,"count":20}\'',
    '',
    '提示：用 --list 查看全部命令，用 --help <命令> 查看参数。',
  ];
  output(`${lines.join('\n')}\n`);
}

// ------------------------------------------------------------------ 主流程

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--config') {
    if (!argv[1]) throw new CliError('--config 后需要配置文件路径');
    selectedConfigPath = resolve(argv[1]);
    explicitConfig = true;
    argv.splice(0, 2);
  }

  if (argv.length === 0) {
    note('错误：缺少 action 参数。用 --list 查看可用命令，用 --help <action> 查看参数。');
    process.exit(1);
  }

  const first = argv[0];

  if (first === '--list' || first === '-l') {
    printList();
    return;
  }
  if (first === '--help' || first === '-h') {
    const target = argv[1];
    if (!target) {
      printUsage();
      return;
    }
    if (ACTIONS[target]) {
      printActionHelp(target);
      return;
    }
    if (SUGAR[target]) {
      printSugarHelp(target);
      return;
    }
    throw new CliError(
      `未知的命令：${target}\n  用 --list 查看常用 action；任意 OneBot action 也可以直接透传。`,
    );
  }
  if (first === '--version' || first === '-v') {
    output(`qq.mjs ${VERSION}\n`);
    return;
  }

  // 快捷命令
  const sugar = Object.prototype.hasOwnProperty.call(SUGAR, first) ? SUGAR[first] : null;
  if (sugar) {
    const plan = sugar.run(argv.slice(1));
    let request = plan;

    // 少数命令（如 history 要看目标到底是群还是好友）需要先查一次辅助信息再决定 action
    if (typeof plan.before === 'function') {
      const probe = plan.before();
      const probeData = await callAction(probe.action, probe.params);
      request = probe.resolve(probeData);
    }

    const data = await callAction(request.action, request.params);
    const result = request.post ? request.post(data) : data;
    output(`${JSON.stringify(result === undefined ? null : result, null, 2)}\n`);
    return;
  }

  if (first.startsWith('-')) {
    throw new CliError(`未知选项：${first}\n  用 --list 或 --help 查看用法。`);
  }

  // 通用透传：action + JSON 参数（参数可以拆成多段）
  const action = first;
  const params = parseJsonParams(argv.slice(1));
  const data = await callAction(action, params);
  output(`${JSON.stringify(data === undefined ? null : data, null, 2)}\n`);
}

main().catch((err) => {
  const message = err instanceof CliError ? err.message : `未预期的错误：${err?.message || err}`;
  note(`错误：${message}`);

  // retcode != 0 时把服务端返回的完整响应也打到 stderr，方便排查
  if (err instanceof CliError && err.response !== undefined) {
    note(`服务端原始响应：\n${JSON.stringify(err.response, null, 2)}`);
  }

  process.exit(1);
});
