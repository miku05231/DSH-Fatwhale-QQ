/**
 * 控制台的关键词自动回复接口：
 *   GET /api/keywords  读规则
 *   PUT /api/keywords  整份保存 { rules: [...] }（写接口由 server.mjs 统一做来源校验）
 * 桥接按文件修改时间热加载，保存后下一条消息生效。
 */

import path from 'node:path';
import { KeywordStore, MATCH_MODES, MAX_RULES, SCOPES } from '../keywords.js';

export function createKeywordsApi({ stateDir, readJsonBody, ok, fail, log }) {
  const store = new KeywordStore({ file: path.join(stateDir, 'keywords.json'), log });

  function meta() {
    return { matchModes: MATCH_MODES, scopes: SCOPES, maxRules: MAX_RULES };
  }

  async function route(req, res, pathname, method) {
    if (pathname !== '/api/keywords') return fail(res, 404, `没有这个接口：${pathname}`);
    if (method === 'GET') return ok(res, { rules: store.rules(), ...meta() });
    if (method !== 'PUT') return fail(res, 405, '只支持 GET / PUT');
    const body = await readJsonBody(req);
    try {
      const rules = await store.save(body.rules);
      log?.info?.(`关键词规则已保存：${rules.length} 条`);
      return ok(res, { rules, ...meta() });
    } catch (err) {
      if (err?.statusCode === 400) return fail(res, 400, err.message);
      throw err;
    }
  }

  return { route };
}
