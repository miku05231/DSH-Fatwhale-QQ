export class BrowserCdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new BrowserCdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
}

export async function expandSessionGroups(cdp) {
  return cdp.evaluate(`(() => {
    const groups = [...document.querySelectorAll('[data-row-key][aria-expanded="false"]')]
      .filter((node) => node.getAttribute('data-row-key').startsWith('workspace:'));
    for (const group of groups) group.click();
    return groups.length;
  })()`);
}

export async function sessionRows(cdp) {
  return cdp.evaluate(`([...document.querySelectorAll('[data-row-key]')].map((node) => ({
    key: node.getAttribute('data-row-key'), text: node.textContent
  })))`);
}

export async function openSessionRow(cdp, sessionId) {
  return cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-row-key]')].find((node) =>
      node.getAttribute('data-row-key').includes(${JSON.stringify(sessionId)}));
    if (!row) return false;
    row.click();
    return true;
  })()`);
}
