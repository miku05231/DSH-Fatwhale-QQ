// src/redact.js —— 日志/错误脱敏
//
// DSH 和 OneBot 的输出里可能带访问 token、API key。桥接的日志、控制台的
// status、错误回复都可能被用户看到或被提交进仓库，所以统一在这里做最后一道
// 过滤。宁可多打几个星号，也不要把密钥漏出去。

/** 常见的密钥/令牌形态 */
const PATTERNS = [
  // URL 查询参数里的 token（DSH web 启动 banner 会打印带 token 的地址）
  [/([?&]token=)[^\s&"'#]+/gi, '$1***'],
  // Authorization: Bearer xxx
  [/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1***'],
  // OpenAI 风格的 sk-xxx
  [/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***'],
  // 形如 apiKey=xxx / "secret": "xxx" / access_token: xxx
  [/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1***'],
];

/**
 * 过滤一段文本里的密钥。非字符串会先转成字符串；超长内容截断，避免把
 * 一整段 stderr 塞进 QQ 消息或日志。
 *
 * @param {unknown} value
 * @param {number} [maxChars=4000]
 * @returns {string}
 */
export function redactSecrets(value, maxChars = 4000) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  if (maxChars > 0 && text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
  return text;
}
