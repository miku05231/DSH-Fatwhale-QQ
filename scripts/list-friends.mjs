// 临时脚本：连上 NapCat 的 OneBot WS，取好友列表与最近私聊，帮助确定管理员 QQ 号
const URL = 'ws://127.0.0.1:3001';

function once(ws, id, action, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout ' + action)), 8000);
    const onMsg = (ev) => {
      let data;
      try { data = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (data?.echo === id) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        data.status === 'ok' || data.retcode === 0 ? resolve(data.data) : reject(new Error(JSON.stringify(data)));
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ action, params, echo: id }));
  });
}

const ws = new WebSocket(URL);
let seq = 0;

ws.addEventListener('open', async () => {
  try {
    const login = await once(ws, 'l' + ++seq, 'get_login_info');
    console.log('机器人账号:', JSON.stringify(login));

    const friends = await once(ws, 'f' + ++seq, 'get_friend_list');
    console.log('好友数:', friends.length);
    for (const f of friends.slice(0, 30)) {
      console.log(`  ${f.user_id}\t${f.remark || f.nickname}`);
    }

    try {
      const groups = await once(ws, 'g' + ++seq, 'get_group_list');
      console.log('群数:', groups.length);
      for (const g of groups.slice(0, 10)) console.log(`  群 ${g.group_id}\t${g.group_name}`);
    } catch (e) { console.log('群列表失败:', e.message); }
  } catch (e) {
    console.error('出错:', e.message);
  } finally {
    ws.close();
    setTimeout(() => process.exit(0), 200);
  }
});

ws.addEventListener('error', (e) => { console.error('WS 错误:', e.message || e); process.exit(1); });
setTimeout(() => { console.error('整体超时'); process.exit(1); }, 20000);
