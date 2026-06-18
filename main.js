'use strict';
/**
 * Electron 主进程
 *  引擎层:每个对话维护一个常驻 claude 进程(--input-format stream-json),
 *          打开对话即预热,后续消息走 stdin,首字/续接更快;同一时刻仅 1 个进程(省内存)。
 *  配置层(cc-switch):服务商档案 + 一键注入 API(safeStorage 加密)
 *  对话层:多对话持久化(标题/消息/sessionId)
 *  插件层:MCP 列表(内置 GUI 自动化 + 自定义/AI 生成),启用禁用;AI 一句话造插件。
 */
const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
const MCP_SERVER = path.join(__dirname, 'mcp', 'gui-automation', 'server.js');
const PLUGINMGR_SERVER = path.join(__dirname, 'mcp', 'plugin-manager', 'server.js');
const AGENTMGR_SERVER = path.join(__dirname, 'mcp', 'agent-manager', 'server.js');
const SELFEVOLVE_SERVER = path.join(__dirname, 'mcp', 'self-evolve', 'server.js');
const PROJECT_DIR = __dirname; // App 自己的源码根目录(自我进化对象)

// 自我进化对话的系统提示词
const EVOLVE_SYS = [
  '你正运行在这个桌面 App 的「自我进化」对话里。【你当前的工作目录就是这个 App 自己的源码根目录】,你可以读写它来改进 App 本身。',
  '源码结构:',
  '- main.js:Electron 主进程(引擎:spawn claude / IPC / 对话·Agent·工作流·插件 的存储与逻辑)',
  '- preload.js:contextBridge 暴露给界面的 API',
  '- renderer/index.html:界面结构 + 全部 CSS;renderer/renderer.js:界面交互逻辑',
  '- mcp/*/server.js:内置 MCP 插件(零依赖 JSON-RPC over stdio)',
  '用户会让你给这个 App【加功能 / 改界面 / 调设计】。你必须按这个流程做:',
  '1) 先调 mcp__selfevolve__snapshot(打 git 快照存档,便于回滚);',
  '2) 用 Read / Edit / Write 工具修改上面的源码文件;改 JS 后用 Bash 跑 `node --check <文件>` 自检语法;',
  '3) 改完让其生效:只动了 renderer/(界面/样式)→ 调 mcp__selfevolve__reload({scope:"renderer"}) 软重载即时生效;动了 main.js 或 preload.js → 调 reload({scope:"app"}) 请求重启(会让用户确认);',
  '4) 用户要撤销 → 调 mcp__selfevolve__rollback({to:"last"})。',
  '改 main.js 这类核心文件要保守、最小改动,改完务必 node --check 通过再 reload。不要改 node_modules。',
].join('\n');

// 引导 Claude 在对话里造插件
const PLUGIN_SYS = [
  '你运行在一个桌面 App 内,内置了「插件管理器」工具。',
  '当用户要求【做/写/创建一个插件或新工具】时:调用 mcp__pluginmgr__create_plugin,参数 name(简短中文名)、description、code。',
  'code 必须是一段【完整、零依赖】的 Node.js stdio MCP server 源码,严格遵循:',
  '- JSON-RPC 2.0 over stdio,逐行读 stdin,stdout 只输出协议消息,日志走 stderr;',
  '- 实现 initialize / notifications/initialized / ping / tools/list / tools/call / resources/list(返回{resources:[]}) / prompts/list(返回{prompts:[]});',
  '- initialize 返回 {protocolVersion: 客户端传来的或"2024-11-05", capabilities:{tools:{}}, serverInfo:{name,version}};',
  '- 每个工具含 name/description/inputSchema;tools/call 成功返 {content:[{type:"text",text}]},失败加 isError:true;',
  '- 只用 Node 内置模块;需要系统能力用 child_process(Windows 的 PowerShell 用绝对路径 $SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe)。',
  '当用户要求【安装某个现成 MCP】(如 Playwright)时:调用 mcp__pluginmgr__add_mcp_server。',
  '当用户要求【做/造/创建一个 XX 的 Agent / 角色 / 助手 / 专家】时:调用 mcp__agentmgr__create_agent,帮他把人设写成具体的 systemPrompt(它是谁、负责什么、风格与输出要求)。需要把一段子任务委托给某个已存在的专家角色时:调用 mcp__agentmgr__run_agent(召唤子代理,全新上下文执行并返回结果)。',
  '创建/安装成功后,用一句话告诉用户已启用、可直接使用。其余普通请求正常回答,不要无故创建插件或 Agent。',
].join('\n');

// ---------- 通用 ----------
const dataFile = (name) => path.join(app.getPath('userData'), name);
function readJson(name, fb) { try { return JSON.parse(fs.readFileSync(dataFile(name), 'utf8')); } catch { return fb; } }
function writeJson(name, obj) { fs.writeFileSync(dataFile(name), JSON.stringify(obj, null, 2), 'utf8'); }
function genId(p) { return (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function send(ch, payload) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload); }

// ===================== 服务商(cc-switch) =====================
function ensureProvDefault(s) {
  if (!Array.isArray(s.profiles)) s.profiles = [];
  if (!s.profiles.find(p => p.id === 'default')) s.profiles.unshift({ id: 'default', name: '默认 · 本机登录', baseUrl: '', model: '', secretType: 'none' });
  if (!s.activeId || !s.profiles.find(p => p.id === s.activeId)) s.activeId = 'default';
  return s;
}
const loadProviders = () => ensureProvDefault(readJson('providers.json', { profiles: [], activeId: 'default' }));
const saveProviders = (s) => writeJson('providers.json', s);
const getActiveProfile = () => { const s = loadProviders(); return s.profiles.find(p => p.id === s.activeId); };
function encryptSecret(plain) {
  if (!plain) return { data: null, enc: false };
  if (safeStorage.isEncryptionAvailable()) return { data: safeStorage.encryptString(plain).toString('base64'), enc: true };
  return { data: Buffer.from(plain, 'utf8').toString('base64'), enc: false };
}
function decryptSecret(prof) {
  if (!prof || !prof.secretEnc) return null;
  try { const buf = Buffer.from(prof.secretEnc, 'base64'); if (prof.secretEncrypted && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf); return buf.toString('utf8'); } catch { return null; }
}
function publicProfiles() {
  const s = loadProviders();
  return { activeId: s.activeId, profiles: s.profiles.map(p => ({ id: p.id, name: p.name, baseUrl: p.baseUrl || '', model: p.model || '', secretType: p.secretType || 'none', hasSecret: !!p.secretEnc, builtin: p.id === 'default' })) };
}
function buildEnv() {
  const env = { ...process.env };
  const prof = getActiveProfile();
  if (!prof || prof.id === 'default') return env;
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  if (prof.baseUrl) env.ANTHROPIC_BASE_URL = prof.baseUrl;
  const secret = decryptSecret(prof);
  if (prof.secretType === 'authToken' && secret) env.ANTHROPIC_AUTH_TOKEN = secret;
  if (prof.secretType === 'apiKey' && secret) env.ANTHROPIC_API_KEY = secret;
  if (prof.model) env.ANTHROPIC_MODEL = prof.model;
  return env;
}

// ===================== 插件 / MCP =====================
function ensureMcpDefault(s) {
  if (!Array.isArray(s.servers)) s.servers = [];
  const g = s.servers.find(x => x.id === 'gui');
  if (!g) s.servers.unshift({ id: 'gui', name: 'GUI 自动化', desc: '控制鼠标/键盘/截屏(内置)', enabled: true, transport: 'stdio', command: 'node', args: [MCP_SERVER], builtin: true });
  else { g.command = 'node'; g.args = [MCP_SERVER]; g.builtin = true; }
  const pm = s.servers.find(x => x.id === 'pluginmgr');
  if (!pm) s.servers.splice(1, 0, { id: 'pluginmgr', name: '插件管理器', desc: '让 Claude 在对话里创建/安装/启停插件(内置)', enabled: true, transport: 'stdio', command: 'node', args: [PLUGINMGR_SERVER], builtin: true });
  else { pm.command = 'node'; pm.args = [PLUGINMGR_SERVER]; pm.builtin = true; }
  const am = s.servers.find(x => x.id === 'agentmgr');
  if (!am) s.servers.splice(2, 0, { id: 'agentmgr', name: 'Agent 管理器', desc: '让 Claude 在对话里创建/编辑/召唤自定义 Agent(内置)', enabled: true, transport: 'stdio', command: 'node', args: [AGENTMGR_SERVER], builtin: true });
  else { am.command = 'node'; am.args = [AGENTMGR_SERVER]; am.builtin = true; }
  // 浏览器:Playwright(受控浏览器)
  const pw = s.servers.find(x => x.id === 'playwright');
  if (!pw) s.servers.push({ id: 'playwright', name: '浏览器(Playwright)', desc: '让 Claude 操作一个受控浏览器:导航/搜索/点击/输入/读取(首次启用会下载,稍慢)', enabled: false, transport: 'stdio', command: 'cmd', args: ['/c', 'npx', '-y', '@playwright/mcp@latest'], builtin: true });
  else { pw.command = 'cmd'; pw.args = ['/c', 'npx', '-y', '@playwright/mcp@latest']; pw.transport = 'stdio'; pw.builtin = true; }
  // 浏览器:接管你正在用的 Chrome(Claude Code --chrome 集成,非 MCP,用 flag 表示)
  const cr = s.servers.find(x => x.id === 'chrome');
  if (!cr) s.servers.push({ id: 'chrome', name: '浏览器(接管我的 Chrome)', desc: '用 Claude 的 Chrome 集成接管你正在用的真实 Chrome(含登录态);需已安装对应扩展', enabled: false, transport: 'flag', builtin: true });
  else cr.builtin = true;
  return s;
}
const loadMcp = () => ensureMcpDefault(readJson('mcp.json', { servers: [] }));
const saveMcp = (s) => writeJson('mcp.json', s);
function publicMcp() {
  return { servers: loadMcp().servers.map(s => ({ id: s.id, name: s.name, desc: s.desc || '', enabled: !!s.enabled, transport: s.transport, command: s.command || '', args: Array.isArray(s.args) ? s.args : [], url: s.url || '', builtin: !!s.builtin, ai: !!s.aiGenerated })) };
}
const ALWAYS_ON_MCP = ['gui', 'pluginmgr', 'agentmgr']; // 核心/管理类内置,任何 Agent 都保留
function selfEvolveEntry() { return { type: 'stdio', command: 'node', args: [SELFEVOLVE_SERVER], env: { PROJECT_DIR, AGENT_DATA_DIR: app.getPath('userData') } }; }
function buildMcpServersObj(allow, includeEvolve) {
  // allow: null/undefined = 全部启用的;Set<id> = 仅这些(加 ALWAYS_ON 永远在)。includeEvolve: 进化对话才注入 selfevolve
  const mcpServers = {};
  for (const s of loadMcp().servers) {
    if (!s.enabled) continue;
    if (s.transport === 'flag') continue;        // flag 类(如 Chrome 集成)不是 MCP,跳过
    if (allow && !ALWAYS_ON_MCP.includes(s.id) && !allow.has(s.id)) continue; // Agent 插件白名单过滤
    if (s.transport === 'http') mcpServers[s.id] = { type: 'http', url: s.url };
    else {
      const entry = { type: 'stdio', command: s.command, args: s.args || [] };
      if (s.id === 'pluginmgr' || s.id === 'agentmgr') entry.env = { AGENT_DATA_DIR: app.getPath('userData') };
      mcpServers[s.id] = entry;
    }
  }
  if (includeEvolve) mcpServers.selfevolve = selfEvolveEntry();
  return mcpServers;
}
function chromeEnabled() { const c = loadMcp().servers.find(s => s.id === 'chrome'); return !!(c && c.enabled); }
function buildMcpConfigFile(allow, includeEvolve) {
  const mcpServers = buildMcpServersObj(allow, includeEvolve);
  writeJson('gui-mcp.json', { mcpServers });
  return { path: dataFile('gui-mcp.json'), sig: JSON.stringify(mcpServers) };
}

// ===================== 对话存储 =====================
const loadConvs = () => { const s = readJson('conversations.json', { list: [] }); if (!Array.isArray(s.list)) s.list = []; return s; };
const saveConvs = (s) => writeJson('conversations.json', s);
const getConv = (id) => loadConvs().list.find(c => c.id === id);
function publicConvList() { return loadConvs().list.map(c => ({ id: c.id, title: c.title || (c.kind === 'plugin' ? '新插件' : '新对话'), updatedAt: c.updatedAt || 0, kind: c.kind || 'chat', pluginId: c.pluginId || null, agentId: c.agentId || null })).sort((a, b) => b.updatedAt - a.updatedAt); }
function createConv(kind) { const s = loadConvs(); const c = { id: genId('c'), kind: kind || 'chat', pluginId: null, title: '', sessionId: null, messages: [], updatedAt: Date.now() }; s.list.push(c); saveConvs(s); return c; }
function convForPlugin(pluginId, name) {
  const s = loadConvs();
  let c = s.list.find(x => x.pluginId === pluginId);
  if (!c) { c = { id: genId('c'), kind: 'plugin', pluginId, title: name || '插件', sessionId: null, messages: [], updatedAt: Date.now() }; s.list.push(c); saveConvs(s); }
  return c;
}
function deleteConv(id) { const s = loadConvs(); s.list = s.list.filter(c => c.id !== id); saveConvs(s); }
function setConvSession(id, sid) { const s = loadConvs(); const c = s.list.find(x => x.id === id); if (c && sid) { c.sessionId = sid; saveConvs(s); } }
function setConvAgent(id, agentId) { const s = loadConvs(); const c = s.list.find(x => x.id === id); if (c) { c.agentId = agentId || null; c.updatedAt = Date.now(); saveConvs(s); } }
function appendMessages(id, msgs) {
  const s = loadConvs(); const c = s.list.find(x => x.id === id); if (!c) return;
  c.messages.push(...msgs);
  if (!c.title) { const u = msgs.find(m => m.type === 'user'); if (u) c.title = u.text.slice(0, 24); }
  c.updatedAt = Date.now(); saveConvs(s);
}

// ===================== 自定义 Agent 存储 =====================
const loadAgents = () => { const s = readJson('agents.json', { agents: [] }); if (!Array.isArray(s.agents)) s.agents = []; return s; };
const saveAgents = (s) => writeJson('agents.json', s);
const getAgent = (id) => id && loadAgents().agents.find(a => a.id === id);
function publicAgents() { return loadAgents().agents.map(a => ({ id: a.id, name: a.name || '新 Agent', emoji: a.emoji || '🤖', systemPrompt: a.systemPrompt || '', plugins: Array.isArray(a.plugins) ? a.plugins : null, model: a.model || '', builtin: !!a.builtin, aiGenerated: !!a.aiGenerated })); }
// 某对话绑定的 Agent → 插件白名单(Set 或 null=全部)
function agentAllowSet(convId) {
  const conv = getConv(convId); if (!conv || !conv.agentId) return null;
  const a = getAgent(conv.agentId); if (!a || !Array.isArray(a.plugins)) return null;
  return new Set(a.plugins);
}

// ===================== 工作流 / 团队 存储 =====================
const loadWorkflows = () => { const s = readJson('workflows.json', { workflows: [] }); if (!Array.isArray(s.workflows)) s.workflows = []; return s; };
const saveWorkflows = (s) => writeJson('workflows.json', s);
function publicWorkflows() { return loadWorkflows().workflows.map(w => ({ id: w.id, name: w.name || '新工作流', emoji: w.emoji || '🧩', stages: Array.isArray(w.stages) ? w.stages : [] })); }

// ===================== 常驻对话引擎 =====================
const engine = { proc: null, convId: null, sessionId: null, ready: false, busy: false, run: null, buf: '', mcpSig: '', startServerIds: [], allow: null, isEvolve: false };

function killEngine() {
  if (engine.proc) { try { engine.proc.stdin.end(); } catch {} try { engine.proc.kill(); } catch {} }
  engine.proc = null; engine.ready = false; engine.busy = false; engine.run = null; engine.buf = '';
  engine.convId = null; engine.sessionId = null; engine.allow = null; engine.isEvolve = false;
}

// 打开/预热某对话的常驻进程
function openEngine(convId) {
  if (engine.proc && engine.convId === convId) return; // 已是该对话
  killEngine();
  const conv = getConv(convId);
  if (!conv) return;
  engine.convId = convId; engine.sessionId = conv.sessionId || null;

  const isEvolve = conv.kind === 'evolve';
  engine.isEvolve = isEvolve;
  const allow = isEvolve ? null : agentAllowSet(convId);
  engine.allow = allow;
  const cfg = buildMcpConfigFile(allow, isEvolve);
  engine.mcpSig = cfg.sig;
  engine.startServerIds = loadMcp().servers.map(s => s.id);
  // 系统提示词:进化对话用 EVOLVE_SYS;否则基础引导 + 该对话绑定 Agent 的人设(若有)
  const ag = isEvolve ? null : getAgent(conv.agentId);
  let sysPrompt = isEvolve ? EVOLVE_SYS : PLUGIN_SYS;
  if (ag && ag.systemPrompt) sysPrompt = PLUGIN_SYS + '\n\n——— 你的角色设定(' + (ag.emoji || '🤖') + ' ' + ag.name + ')———\n' + ag.systemPrompt;
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--mcp-config', cfg.path, '--strict-mcp-config', '--permission-mode', 'bypassPermissions',
    '--append-system-prompt', sysPrompt];
  if (ag && ag.model) args.push('--model', ag.model);
  if (chromeEnabled()) args.push('--chrome');
  if (conv.sessionId) args.push('--resume', conv.sessionId);

  // 进化对话:工作目录指向 App 源码根目录,让 Claude 能读改自己
  const cwd = isEvolve ? PROJECT_DIR : app.getPath('userData');
  const child = spawn('claude', args, { shell: true, cwd, env: buildEnv() });
  engine.proc = child;
  send('engine-status', { convId, state: 'warming' });

  child.stdout.on('data', (d) => {
    engine.buf += d.toString(); let idx;
    while ((idx = engine.buf.indexOf('\n')) >= 0) { const l = engine.buf.slice(0, idx).trim(); engine.buf = engine.buf.slice(idx + 1); if (l) onEngineLine(l); }
  });
  child.stderr.on('data', () => {});
  child.on('error', (e) => { send('engine-event', { convId, kind: 'system', text: 'spawn 失败: ' + e.message }); finishTurn(true); });
  child.on('close', () => {
    if (engine.run && engine.busy) finishTurn(true);
    if (engine.proc === child) { engine.proc = null; engine.ready = false; }
  });
}

function onEngineLine(line) {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const convId = engine.convId;
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        if (msg.session_id) { engine.sessionId = msg.session_id; setConvSession(convId, msg.session_id); }
        engine.ready = true; send('engine-status', { convId, state: 'ready' });
      }
      break;
    case 'stream_event': {
      const ev = msg.event || {};
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        if (engine.run) engine.run.accText += ev.delta.text;
        send('engine-event', { convId, kind: 'text', text: ev.delta.text });
      }
      break;
    }
    case 'assistant': {
      const blocks = (msg.message && msg.message.content) || [];
      for (const b of blocks) if (b.type === 'tool_use') { flushAssistant(); if (engine.run) engine.run.pending.push({ type: 'tool', name: b.name, input: b.input }); send('engine-event', { convId, kind: 'tool', name: b.name, input: b.input }); }
      break;
    }
    case 'user': {
      const blocks = (msg.message && msg.message.content) || [];
      for (const b of blocks) if (b.type === 'tool_result') { let t = b.content; if (Array.isArray(t)) t = t.map(c => c.text || '').join(''); t = String(t || '').slice(0, 400); if (engine.run) engine.run.pending.push({ type: 'tool_result', text: t }); send('engine-event', { convId, kind: 'tool_result', text: t }); }
      break;
    }
    case 'result':
      if (msg.session_id) { engine.sessionId = msg.session_id; setConvSession(convId, msg.session_id); }
      if (engine.run) engine.run.resultText = msg.result || '';
      flushAssistant();
      send('engine-event', { convId, kind: 'result', text: msg.result || '' });
      finishTurn(false);
      break;
  }
}
function flushAssistant() { if (engine.run && engine.run.accText.trim()) engine.run.pending.push({ type: 'assistant', text: engine.run.accText }); if (engine.run) engine.run.accText = ''; }
function finishTurn(aborted) {
  if (!engine.run) { send('engine-done', {}); return; }
  flushAssistant();
  const convId = engine.run.convId;
  const resultText = engine.run.resultText || '';
  appendMessages(convId, engine.run.pending);
  engine.run = null; engine.busy = false;
  let reload = false;
  if (!aborted) {
    const cur = JSON.stringify(buildMcpServersObj(engine.allow, engine.isEvolve));
    if (cur !== engine.mcpSig) {
      reload = true;
      // 若当前是「未绑定的插件对话」,把本轮新造出来的插件绑到它身上(成为这个插件的家)
      const conv0 = getConv(convId);
      if (conv0 && conv0.kind === 'plugin' && !conv0.pluginId) {
        const startIds = engine.startServerIds || [];
        const newSrv = loadMcp().servers.find(s => !s.builtin && !startIds.includes(s.id));
        if (newSrv) { const st = loadConvs(); const cc = st.list.find(x => x.id === convId); if (cc) { cc.pluginId = newSrv.id; cc.title = newSrv.name; saveConvs(st); } }
      }
      send('mcp-updated', publicMcp());
    }
  }
  send('engine-done', { convId, conversations: publicConvList() });
  if (reload) { send('engine-event', { convId, kind: 'system', text: '🧩 插件已更新,正在重载,稍后即可使用…' }); killEngine(); openEngine(convId); return; }
  // —— agent loop:worker 一轮结束 → 交给审查/验收 ——
  if (loop.active && loop.convId === convId && !aborted) loopAfterWorker(convId, resultText);
  // —— 自我进化:本轮结束后执行挂起的重载/重启 ——
  maybeDoEvolveReload();
}

function engineSend(convId, prompt) {
  if (engine.busy) { send('engine-event', { convId, kind: 'system', text: '引擎忙,请等当前任务结束。' }); return; }
  if (!getConv(convId)) return;
  if (!engine.proc || engine.convId !== convId) openEngine(convId);
  engine.busy = true;
  engine.run = { convId, pending: [{ type: 'user', text: prompt }], accText: '' };
  const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n';
  try { engine.proc.stdin.write(payload); } catch (e) { send('engine-event', { convId, kind: 'system', text: '写入失败: ' + e.message }); finishTurn(true); }
}

// ===================== 自我进化:重载桥 + git 基线 =====================
const EVOLVE_SIGNAL = () => path.join(app.getPath('userData'), '.evolve-signal.json');
let pendingEvolveReload = null; // 'reload' | 'restart'
function maybeDoEvolveReload() {
  if (!pendingEvolveReload || engine.busy) return; // 等本轮结束再动,避免打断
  const scope = pendingEvolveReload; pendingEvolveReload = null;
  if (scope === 'restart') {
    const r = dialog.showMessageBoxSync(mainWindow, { type: 'question', buttons: ['重启 App', '稍后'], defaultId: 0, cancelId: 1, message: '自我进化修改了主进程代码', detail: '需要重启 App 才能让 main.js / preload.js 的改动生效。现在重启?' });
    if (r === 0) { app.relaunch(); app.exit(0); }
  } else {
    if (mainWindow && !mainWindow.isDestroyed()) { send('engine-event', { convId: engine.convId, kind: 'system', text: '🧬 界面已重载,改动生效。' }); mainWindow.webContents.reloadIgnoringCache(); }
  }
}
function watchEvolveSignal() {
  const f = EVOLVE_SIGNAL();
  try { fs.writeFileSync(f, JSON.stringify({ action: 'idle', ts: 0 }), 'utf8'); } catch {}
  fs.watchFile(f, { interval: 700 }, () => {
    let s; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return; }
    if (!s || s.action === 'idle') return;
    if (s.action === 'restart') pendingEvolveReload = 'restart';
    else if (s.action === 'reload') pendingEvolveReload = 'reload';
    try { fs.writeFileSync(f, JSON.stringify({ action: 'idle', ts: 0 }), 'utf8'); } catch {}
    setTimeout(maybeDoEvolveReload, 200);
  });
}
function ensureGitBaseline() {
  try {
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: PROJECT_DIR, encoding: 'utf8' });
    if ((inside.stdout || '').trim() === 'true') return;
    const gi = path.join(PROJECT_DIR, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, ['node_modules/', '*.log', '*.test.json', 'engine-test*', '.evolve-signal.json'].join('\n') + '\n', 'utf8');
    spawnSync('git', ['init'], { cwd: PROJECT_DIR });
    spawnSync('git', ['add', '-A'], { cwd: PROJECT_DIR });
    spawnSync('git', ['-c', 'user.email=agent@local', '-c', 'user.name=Self Evolve', 'commit', '-m', 'baseline: 自我进化基线'], { cwd: PROJECT_DIR });
  } catch (e) { /* ignore */ }
}
function evolveRollback() {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: PROJECT_DIR, encoding: 'utf8' });
  if ((inside.stdout || '').trim() !== 'true') return { ok: false, msg: '还没有快照可回滚' };
  const r = spawnSync('git', ['reset', '--hard', 'HEAD~1'], { cwd: PROJECT_DIR, encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, msg: (r.stderr || '回滚失败').trim() };
  pendingEvolveReload = 'reload'; setTimeout(maybeDoEvolveReload, 200);
  return { ok: true, msg: '已回滚到上一个快照(界面将重载;若回滚了 main.js 改动请手动重启)' };
}

// ===================== Agent Loop(worker / reviewer / grader)=====================
// worker = 常驻对话进程(带全套 harness:插件/截屏/浏览器);reviewer/grader = 一次性 claude -p,全新上下文,串行跑(省内存)
const REVIEWER_SYS = [
  '你是一个独立审查者,带着全新的上下文,没有"作者的偏爱",也没看过执行过程。',
  '只审查执行者【这一轮】产出的工作,找三类问题:正确性 bug、被忽略的边界/遗漏、可简化或多余之处。',
  '每条给:一句话说明 + 严重程度(高/中/低)。不要重写代码,不要动手改任何东西。',
  '如果确实没问题,只回复"通过"。不要寒暄,你的输出就是结论。',
].join('\n');
const GRADER_SYS = [
  '你是一个独立验收员(grader),带着全新的上下文,没看过执行过程,不偏袒执行者。',
  '给定【目标】和执行者声称的【产出】,判断目标是否【真的】达成。',
  '你可以(并鼓励)用 Read / Bash / Glob / Grep 等工具【亲自核实】(去读文件、列目录、跑命令看真实结果),不要只信执行者的话。',
  '只做判定,绝不修改任何东西。',
  '最终【只输出一行 JSON】,不要任何多余文字:{"met": true 或 false, "score": 0到100的整数, "feedback": "若未达成,具体还差什么、给执行者的下一步;若达成,一句话说明"}',
].join('\n');

const loop = { active: false, convId: null, goal: '', iter: 0, maxIter: 6, withReviewer: true };
function loopEvent(o) { send('loop-event', o); }

// 跑一个一次性角色进程,返回其最终文本
function runOneShot(roleSys, prompt) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--append-system-prompt', roleSys];
    let out = ''; let child;
    try { child = spawn('claude', args, { shell: true, cwd: app.getPath('userData'), env: buildEnv() }); }
    catch (e) { resolve(''); return; }
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(''));
    child.on('close', () => { let text = ''; try { const j = JSON.parse(out); text = j.result || ''; } catch { text = out; } resolve(String(text || '')); });
    try { child.stdin.write(prompt); child.stdin.end(); } catch { resolve(''); }
  });
}
function parseVerdict(text) {
  const m = text && text.match(/\{[\s\S]*\}/);
  if (m) { try { const o = JSON.parse(m[0]); return { met: !!o.met, score: Number(o.score) || 0, feedback: String(o.feedback || '') }; } catch {} }
  const t = text || '';
  const met = /(达成|通过|完成|met\s*[:=]?\s*true)/i.test(t) && !/(未达成|没达成|未通过|不通过|未完成|met\s*[:=]?\s*false)/i.test(t);
  return { met, score: 0, feedback: t.slice(0, 600) };
}

function startLoop(convId, goal, maxIter, withReviewer) {
  if (!getConv(convId)) return;
  if (engine.busy) { loopEvent({ convId, kind: 'error', text: '引擎忙,请等当前任务结束再启动循环。' }); return; }
  loop.active = true; loop.convId = convId; loop.goal = goal; loop.iter = 1;
  loop.maxIter = Math.max(1, Math.min(20, Number(maxIter) || 6));
  loop.withReviewer = withReviewer !== false;
  loopEvent({ convId, kind: 'start', goal, maxIter: loop.maxIter, withReviewer: loop.withReviewer });
  const wp = `[Agent Loop 目标]\n${goal}\n\n这是一个自动循环任务。请朝这个目标做【实际操作】(可调用你的全部工具:插件 / 看屏幕 / 操作应用 / 浏览器等)。本轮做完后,会有一个独立验收员去【真实核实】是否达成;若未达成你会收到具体反馈再继续。本轮先尽力推进,并在结尾简要说明你做了什么、当前进展。`;
  engineSend(convId, wp);
}

async function loopAfterWorker(convId, resultText) {
  if (!loop.active || loop.convId !== convId) return;
  const summary = resultText && resultText.trim() ? resultText.trim().slice(0, 4000) : '(执行者无文字总结,请直接核实真实结果)';
  let issues = '';
  if (loop.withReviewer) {
    loopEvent({ convId, kind: 'reviewing', iter: loop.iter });
    issues = await runOneShot(REVIEWER_SYS, `目标:\n${loop.goal}\n\n执行者本轮的产出/说明:\n${summary}\n\n请审查这一轮的工作。`);
    if (!loop.active || loop.convId !== convId) return;
    loopEvent({ convId, kind: 'review', iter: loop.iter, text: issues });
  }
  loopEvent({ convId, kind: 'grading', iter: loop.iter });
  const gtext = await runOneShot(GRADER_SYS, `目标:\n${loop.goal}\n\n执行者本轮的产出/说明:\n${summary}\n\n请独立核实目标是否真的达成,只输出一行 JSON。`);
  if (!loop.active || loop.convId !== convId) return;
  const v = parseVerdict(gtext);
  loopEvent({ convId, kind: 'verdict', iter: loop.iter, met: v.met, score: v.score, feedback: v.feedback });
  if (v.met) { loop.active = false; loopEvent({ convId, kind: 'done', met: true, iter: loop.iter }); return; }
  if (loop.iter >= loop.maxIter) { loop.active = false; loopEvent({ convId, kind: 'done', met: false, iter: loop.iter, reason: 'maxIter' }); return; }
  loop.iter++;
  loopEvent({ convId, kind: 'next', iter: loop.iter });
  const cont = `[验收未通过 · 进入第 ${loop.iter} 轮]\n验收员反馈:${v.feedback || '(无)'}\n${loop.withReviewer ? '审查员意见:' + (issues || '(无)') + '\n' : ''}请据此继续推进并修正问题。目标重申:${loop.goal}`;
  engineSend(convId, cont);
}
function stopLoop() { if (loop.active) { const cid = loop.convId; loop.active = false; loopEvent({ convId: cid, kind: 'done', met: false, reason: 'stopped' }); } }

// ===================== 工作流执行引擎(多 Agent 协同:阶段顺序 + 阶段内并行)=====================
const WF_CONCURRENCY = 2; // 并行任务最大并发(照顾内存)
const wf = { active: false, convId: null, id: null };
function wfEvent(o) { send('workflow-event', o); }
function applyVars(tpl, input, prev) { return String(tpl == null ? '' : tpl).replace(/\{\{\s*input\s*\}\}/g, input || '').replace(/\{\{\s*prev\s*\}\}/g, prev || ''); }

// 给某 Agent 写一份按其插件白名单过滤的 mcp 配置(独立文件,不动常驻引擎的 gui-mcp.json)
function writeAgentMcpConfig(agent) {
  const allow = Array.isArray(agent.plugins) ? new Set(agent.plugins) : null;
  const mcpServers = buildMcpServersObj(allow);
  const name = 'wf-mcp-' + agent.id + '.json';
  writeJson(name, { mcpServers });
  return dataFile(name);
}
// 用某 Agent 的人设+模型+其插件,执行一个子任务,返回文本
function runAgentTask(agent, taskText) {
  return new Promise((resolve) => {
    let cfgPath; try { cfgPath = writeAgentMcpConfig(agent); } catch { cfgPath = null; }
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--append-system-prompt', agent.systemPrompt || ''];
    if (cfgPath) args.push('--mcp-config', cfgPath, '--strict-mcp-config');
    if (agent.model) args.push('--model', agent.model);
    let out = ''; let child;
    try { child = spawn('claude', args, { shell: true, cwd: app.getPath('userData'), env: buildEnv() }); }
    catch (e) { resolve('启动失败: ' + e.message); return; }
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', e => resolve('启动失败: ' + e.message));
    child.on('close', () => { let t = ''; try { t = JSON.parse(out).result || ''; } catch { t = out; } resolve(String(t || '(无输出)')); });
    try { child.stdin.write(taskText); child.stdin.end(); } catch (e) { resolve('写入失败: ' + e.message); }
  });
}
// 并发池
async function runPool(items, limit, fn) {
  const results = new Array(items.length); let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx], idx); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function runWorkflow(convId, wfId, input) {
  if (wf.active) { wfEvent({ convId, kind: 'error', text: '已有工作流在运行,请等它结束。' }); return; }
  const w = loadWorkflows().workflows.find(x => x.id === wfId);
  if (!w) { wfEvent({ convId, kind: 'error', text: '未找到工作流。' }); return; }
  const byId = {}; loadAgents().agents.forEach(a => byId[a.id] = a);
  wf.active = true; wf.convId = convId; wf.id = wfId;
  wfEvent({ convId, kind: 'start', name: w.name, emoji: w.emoji || '🧩', stages: (w.stages || []).length, input });
  let prev = '';
  try {
    const stages = w.stages || [];
    for (let si = 0; si < stages.length; si++) {
      if (!wf.active) break;
      const st = stages[si];
      const tasks = (st.tasks || []).filter(t => t.agentId && byId[t.agentId]);
      const par = !!st.parallel && tasks.length > 1;
      wfEvent({ convId, kind: 'stage', index: si, total: stages.length, name: st.name || ('第 ' + (si + 1) + ' 阶段'), parallel: par, count: tasks.length });
      if (!tasks.length) { wfEvent({ convId, kind: 'stage-done', index: si, combined: prev }); continue; }
      const run1 = async (t, idx) => {
        const ag = byId[t.agentId];
        wfEvent({ convId, kind: 'task-start', stage: si, task: idx, agent: (ag.emoji || '🤖') + ' ' + ag.name });
        const res = await runAgentTask(ag, applyVars(t.prompt, input, prev) || input);
        wfEvent({ convId, kind: 'task-done', stage: si, task: idx, agent: (ag.emoji || '🤖') + ' ' + ag.name, text: res });
        return { agent: ag.name, emoji: ag.emoji || '🤖', text: res };
      };
      let outs;
      if (par) outs = await runPool(tasks, WF_CONCURRENCY, run1);
      else { outs = []; for (let k = 0; k < tasks.length; k++) { if (!wf.active) break; outs.push(await run1(tasks[k], k)); } }
      prev = outs.map(o => `【${o.emoji} ${o.agent}】\n${o.text}`).join('\n\n');
      wfEvent({ convId, kind: 'stage-done', index: si, combined: prev });
    }
    if (wf.active) wfEvent({ convId, kind: 'done', output: prev });
  } catch (e) { wfEvent({ convId, kind: 'error', text: String(e.message || e) }); }
  finally { wf.active = false; }
}
function stopWorkflow() { if (wf.active) { const cid = wf.convId; wf.active = false; wfEvent({ convId: cid, kind: 'done', output: '(已手动停止)', stopped: true }); } }

// ===================== 窗口 =====================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080, height: 780, minWidth: 820, minHeight: 560, title: 'Claude 桌面 Agent', backgroundColor: '#faf9f5',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}
app.whenReady().then(() => { try { saveMcp(loadMcp()); } catch {} createWindow(); watchEvolveSignal(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('window-all-closed', () => { stopLoop(); stopWorkflow(); killEngine(); if (process.platform !== 'darwin') app.quit(); });

// ===================== IPC =====================
ipcMain.on('run-prompt', (_e, { conversationId, prompt }) => engineSend(conversationId, String(prompt || '')));
ipcMain.on('engine-open', (_e, convId) => { if (convId) openEngine(convId); });
ipcMain.on('loop:run', (_e, { convId, goal, maxIter, withReviewer }) => { if (convId && goal && String(goal).trim()) startLoop(convId, String(goal).trim(), maxIter, withReviewer); });
ipcMain.on('loop:stop', () => stopLoop());

ipcMain.handle('conv:list', () => publicConvList());
ipcMain.handle('conv:get', (_e, id) => { const c = getConv(id); return c ? { id: c.id, title: c.title || '', kind: c.kind || 'chat', pluginId: c.pluginId || null, agentId: c.agentId || null, messages: c.messages || [] } : null; });
ipcMain.handle('conv:create', (_e, arg) => { const kind = (arg && typeof arg === 'object') ? arg.kind : arg; const agentId = (arg && typeof arg === 'object') ? arg.agentId : null; const k = (kind === 'plugin' || kind === 'evolve') ? kind : 'chat'; if (k === 'evolve') ensureGitBaseline(); const c = createConv(k); if (agentId) setConvAgent(c.id, agentId); return { conv: { id: c.id, title: '', kind: c.kind, agentId: agentId || null, messages: [] }, conversations: publicConvList() }; });
ipcMain.handle('conv:forPlugin', (_e, { pluginId, name }) => { const c = convForPlugin(pluginId, name); return { conv: { id: c.id, title: c.title || name || '插件', kind: 'plugin', pluginId, messages: c.messages || [] }, conversations: publicConvList() }; });
ipcMain.handle('conv:setAgent', (_e, { convId, agentId }) => { if (!getConv(convId)) return null; setConvAgent(convId, agentId); if (loop.active && loop.convId === convId) stopLoop(); if (engine.convId === convId) { killEngine(); openEngine(convId); } return { id: convId, agentId: agentId || null }; });
ipcMain.handle('conv:delete', (_e, id) => { if (loop.active && loop.convId === id) stopLoop(); if (engine.convId === id) killEngine(); deleteConv(id); return publicConvList(); });

// ---- 自定义 Agent ----
ipcMain.handle('agents:list', () => publicAgents());
ipcMain.handle('agents:save', (_e, p) => {
  const s = loadAgents(); let a = s.agents.find(x => x.id === p.id);
  if (!a) { a = { id: genId('agent'), builtin: false }; s.agents.push(a); }
  if (!a.builtin) {
    a.name = (p.name || '').trim() || '新 Agent';
    a.emoji = (p.emoji || '🤖').slice(0, 4);
    a.systemPrompt = String(p.systemPrompt || '');
    a.plugins = Array.isArray(p.plugins) ? p.plugins : null;
    a.model = (p.model || '').trim();
  }
  saveAgents(s);
  // 若当前对话正用这个 Agent,热重载使改动生效
  if (engine.convId) { const cc = getConv(engine.convId); if (cc && cc.agentId === a.id) { killEngine(); openEngine(engine.convId); } }
  return publicAgents();
});
ipcMain.handle('agents:remove', (_e, id) => {
  const s = loadAgents(); s.agents = s.agents.filter(a => a.id !== id || a.builtin); saveAgents(s);
  // 解绑用到它的对话
  const cs = loadConvs(); let changed = false;
  for (const c of cs.list) if (c.agentId === id) { c.agentId = null; changed = true; }
  if (changed) saveConvs(cs);
  if (engine.convId) { const cc = getConv(engine.convId); if (cc && !cc.agentId) { /* 已解绑,下次打开生效 */ } }
  return publicAgents();
});

// ---- 工作流 / 团队 ----
ipcMain.handle('workflows:list', () => publicWorkflows());
ipcMain.handle('workflows:save', (_e, p) => {
  const s = loadWorkflows(); let w = s.workflows.find(x => x.id === p.id);
  if (!w) { w = { id: genId('wf') }; s.workflows.push(w); }
  w.name = (p.name || '').trim() || '新工作流';
  w.emoji = (p.emoji || '🧩').slice(0, 4);
  w.stages = Array.isArray(p.stages) ? p.stages.map(st => ({ name: (st.name || '').trim(), parallel: !!st.parallel, tasks: Array.isArray(st.tasks) ? st.tasks.map(t => ({ agentId: t.agentId || '', prompt: String(t.prompt || '') })) : [] })) : [];
  saveWorkflows(s); return publicWorkflows();
});
ipcMain.handle('workflows:remove', (_e, id) => { const s = loadWorkflows(); s.workflows = s.workflows.filter(w => w.id !== id); saveWorkflows(s); return publicWorkflows(); });
ipcMain.on('workflow:run', (_e, { convId, id, input }) => { if (convId && id) runWorkflow(convId, id, String(input || '')); });
ipcMain.on('workflow:stop', () => stopWorkflow());

// ---- 自我进化 ----
ipcMain.handle('evolve:rollback', () => evolveRollback());

ipcMain.handle('providers:list', () => publicProfiles());
ipcMain.handle('providers:save', (_e, p) => {
  const s = loadProviders(); let prof = s.profiles.find(x => x.id === p.id);
  if (!prof) { prof = { id: genId('p') }; s.profiles.push(prof); }
  if (prof.id !== 'default') {
    prof.name = (p.name || '').trim() || '未命名服务商'; prof.baseUrl = (p.baseUrl || '').trim(); prof.model = (p.model || '').trim(); prof.secretType = p.secretType || 'none';
    if (p.secretType === 'none') { prof.secretEnc = null; prof.secretEncrypted = false; }
    else if (p.secret) { const enc = encryptSecret(p.secret); prof.secretEnc = enc.data; prof.secretEncrypted = enc.enc; }
  }
  saveProviders(s); return publicProfiles();
});
ipcMain.handle('providers:remove', (_e, id) => { if (id === 'default') return publicProfiles(); const s = loadProviders(); s.profiles = s.profiles.filter(p => p.id !== id); if (s.activeId === id) s.activeId = 'default'; saveProviders(s); return publicProfiles(); });
ipcMain.handle('providers:setActive', (_e, id) => { const s = loadProviders(); if (s.profiles.find(p => p.id === id)) { s.activeId = id; saveProviders(s); stopLoop(); stopWorkflow(); killEngine(); } return publicProfiles(); });

ipcMain.handle('mcp:list', () => publicMcp());
ipcMain.handle('mcp:toggle', (_e, { id, enabled }) => { const s = loadMcp(); const x = s.servers.find(v => v.id === id); if (x) x.enabled = !!enabled; saveMcp(s); return publicMcp(); });
ipcMain.handle('mcp:save', (_e, p) => {
  const s = loadMcp(); let x = s.servers.find(v => v.id === p.id);
  if (!x) { x = { id: genId('m'), builtin: false }; s.servers.push(x); }
  if (!x.builtin) {
    x.name = (p.name || '').trim() || '未命名插件'; x.desc = (p.desc || '').trim();
    x.transport = p.transport === 'http' ? 'http' : 'stdio';
    if (x.transport === 'http') { x.url = (p.url || '').trim(); x.command = ''; x.args = []; }
    else { x.command = (p.command || '').trim(); x.args = (p.args || '').trim() ? p.args.trim().split(/\s+/) : []; x.url = ''; }
    if (typeof p.enabled === 'boolean') x.enabled = p.enabled;
  }
  saveMcp(s); return publicMcp();
});
ipcMain.handle('mcp:remove', (_e, id) => { if (id === 'gui' || id === 'pluginmgr') return publicMcp(); const s = loadMcp(); s.servers = s.servers.filter(v => v.id !== id); saveMcp(s); return publicMcp(); });
