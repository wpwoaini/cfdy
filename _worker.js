// KVStore 类（模拟，实际用 env.NODES）
class KVStore {
  constructor(kv) {
    this.kv = kv;
  }

  async list() {
    const raw = await this.kv.get('nodes');
    return raw ? JSON.parse(raw) : [];
  }

  async add(node) {
    const list = await this.list();
    list.push(node);
    await this.kv.put('nodes', JSON.stringify(list));
  }

  async delete(uuid) {
    const list = await this.list();
    await this.kv.put('nodes', JSON.stringify(list.filter(n => n.uuid !== uuid)));
  }
}

// 路由处理
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. 静态文件：仅 / 和 /admin（admin.html 需要手动上传或用 JS 生成）
    if (path === '/') {
      if (env.FAKE_URL) return Response.redirect(env.FAKE_URL, 302);
      return new Response(htmlIndex, { headers: { 'Content-Type': 'text/html' } });
    }
    if (path === '/admin') {
      return new Response(htmlAdmin, { headers: { 'Content-Type': 'text/html' } });
    }

    // 2. API
    if (path.startsWith('/api/')) return await handleAPI(request, env, url);

    // 3. 订阅
    if (path === '/sub') return await handleSub(request, env);

    // 4. VLESS
    if (path === '/vless') return await handleVless(request, env);

    // 5. Trojan
    if (path === '/trojan') return await handleTrojan(request, env);

    return new Response('Not Found', { status: 404 });
  }
};

// HTML 模板（内嵌，避免额外文件）
const htmlIndex = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>EdgeTunnel</title>
<style>body{font-family:Arial;text-align:center;padding:50px;background:#f0f0f0;}h1{color:#333;}</style>
</head>
<body>
<h1>EdgeTunnel 已部署！</h1><p>学习/测试用代理中转服务。访问 <a href="/admin">/admin</a> 进入面板。</p>
</body></html>`;

const htmlAdmin = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>Admin - EdgeTunnel</title>
<style>body{font-family:Arial;max-width:600px;margin:40px auto;padding:20px;background:#fff;border:1px solid #ddd;}
input,button{width:100%;padding:10px;margin:8px 0;}ul{list-style:none;padding:0;}li{border:1px solid #eee;margin:8px 0;padding:10px;display:flex;justify-content:space-between;}</style>
</head>
<body>
<h2>登录</h2><form id="login"><input type="password" placeholder="ADMIN 密码" required><button type="submit">登录</button></form>
<div id="panel" style="display:none;"><h2>节点管理</h2><button onclick="add()">添加节点</button><ul id="list"></ul><h2>订阅链接</h2><p id="sub"></p></div>
<script>
const api = (path, init = {}) => fetch('/api' + path, { ...init, headers: { ...init.headers, Authorization: localStorage.token || '' } });
if (localStorage.token) showPanel();
document.getElementById('login').onsubmit = async e => { e.preventDefault(); const pwd = e.target[0].value; const r = await fetch('/api/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pwd})}); if (r.ok) { localStorage.token = await r.text(); showPanel(); } else alert('密码错误'); };
async function showPanel() { document.getElementById('login').style.display='none'; document.getElementById('panel').style.display='block'; await load(); const sub = await (await api('/sub')).text(); document.getElementById('sub').textContent = location.origin + sub; }
async function load() { const data = await (await api('/nodes')).json(); const ul = document.getElementById('list'); ul.innerHTML = data.map(n=>'<li>'+n.name+' <code>'+n.uuid.slice(0,8)+'...</code><button onclick="del(\\'+n.uuid+\\')">删除</button></li>').join(''); }
async function add() { const name = prompt('节点名称'); const uuid = prompt('UUID（留空自动生成）') || crypto.randomUUID(); await api('/nodes', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,uuid})}); load(); }
window.del = async uuid => { await api('/nodes/'+uuid, {method:'DELETE'}); load(); };
</script></body></html>`;

// ========== API ==========
async function handleAPI(request, env, url) {
  const kv = new KVStore(env.NODES);
  const auth = request.headers.get('Authorization') || '';

  // 登录
  if (url.pathname === '/api/login' && request.method === 'POST') {
    const { pwd } = await request.json();
    if (pwd !== env.ADMIN) return new Response('Forbidden', { status: 403 });
    return new Response(crypto.randomUUID());
  }

  if (!auth) return new Response('Unauthorized', { status: 401 });

  // 节点列表
  if (url.pathname === '/api/nodes' && request.method === 'GET') {
    return Response.json(await kv.list());
  }

  // 添加节点
  if (url.pathname === '/api/nodes' && request.method === 'POST') {
    const { name, uuid } = await request.json();
    await kv.add({ name, uuid: uuid || crypto.randomUUID() });
    return new Response('OK');
  }

  // 删除节点
  if (url.pathname.startsWith('/api/nodes/') && request.method === 'DELETE') {
    const uuid = url.pathname.split('/').pop();
    await kv.delete(uuid);
    return new Response('OK');
  }

  // 订阅路径
  if (url.pathname === '/api/sub') {
    return new Response(`/sub?key=${env.KEY}`);
  }

  return new Response('Not Found', { status: 404 });
}

// ========== 订阅 ==========
async function handleSub(request, env) {
  const key = new URL(request.url).searchParams.get('key');
  if (key !== env.KEY) return new Response('Invalid key', { status: 403 });

  const nodes = await new KVStore(env.NODES).list();
  const uuid = env.UUID || nodes[0]?.uuid || crypto.randomUUID();
  const host = new URL(request.url).host;

  const vless = `vless://${uuid}@${host}/vless?encryption=none&security=none&type=ws#EdgeTunnel`;
  return new Response(vless);
}

// ========== VLESS ==========
async function handleVless(request, env) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Upgrade required', { status: 426 });
  }

  const uuid = new URL(request.url).searchParams.get('uuid') || env.UUID;
  const nodes = await new KVStore(env.NODES).list();
  if (!uuid || !nodes.some(n => n.uuid === uuid)) {
    return new Response('Invalid UUID', { status: 403 });
  }

  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  // 简化代理：实际需 TCP 隧道，这里用 fetch 示例（替换为您的后端）
  // 示例：转发到 PROXYIP（需自定义）
  const backend = env.PROXYIP;
  if (!backend) return new Response('No backend', { status: 500 });

  // 双向 WebSocket 转发（简化，生产用 Durable Objects）
  server.addEventListener('message', event => {
    // 转发到后端 WS 或 fetch
    fetch(`ws://${backend}/proxy`, { method: 'POST', body: event.data });
  });

  return new Response(null, { status: 101, webSocket: client });
}

// ========== Trojan ==========
async function handleTrojan(request, env) {
  const pass = new URL(request.url).searchParams.get('password') || env.UUID;
  const nodes = await new KVStore(env.NODES).list();
  if (!nodes.some(n => n.uuid === pass)) {
    return new Response('Invalid password', { status: 403 });
  }
  return handleVless(request, env);
}
