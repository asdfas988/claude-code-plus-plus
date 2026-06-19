'use strict';
/**
 * Electron 主进程
 *  引擎层:每个对话维护一个常驻 claude 进程(--input-format stream-json),
 *          打开对话即预热,后续消息走 stdin,首字/续接更快;同一时刻仅 1 个进程(省内存)。
 *  配置层(cc-switch):服务商档案 + 一键注入 API(safeStorage 加密)
 *  对话层:多对话持久化(标题/消息/sessionId)
 *  插件层:MCP 列表(内置 GUI 自动化 + 自定义/AI 生成),启用禁用;AI 一句话造插件。
 */
const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let mainWindow = null;
const MCP_SERVER = path.join(__dirname, 'mcp', 'gui-automation', 'server.js');
const PLUGINMGR_SERVER = path.join(__dirname, 'mcp', 'plugin-manager', 'server.js');
const AGENTMGR_SERVER = path.join(__dirname, 'mcp', 'agent-manager', 'server.js');
const SELFEVOLVE_SERVER = path.join(__dirname, 'mcp', 'self-evolve', 'server.js');
const PROJECT_DIR = __dirname; // App 自己的源码根目录(自我进化对象)
// Playwright MCP:本地已固定安装则用 node 直接起 cli.js(秒开、免联网、无 cmd/npx 开销);
// 没装上则退回 npx(版本已固定,走缓存而非每次解析 @latest)。
const PW_CLI = path.join(__dirname, 'node_modules', '@playwright', 'mcp', 'cli.js');
const PW_VER = '0.0.76';
function pwEntry(extra) {
  if (fs.existsSync(PW_CLI)) return { command: 'node', args: [PW_CLI, ...extra] };
  return { command: 'cmd', args: ['/c', 'npx', '-y', '@playwright/mcp@' + PW_VER, ...extra] };
}

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
  // 浏览器:Playwright(默认有窗口,方便看到 Claude 在干什么;--isolated 用独立 profile,不污染你自己的 Chrome)
  const pwIso = pwEntry(['--isolated']);
  const pw = s.servers.find(x => x.id === 'playwright');
  if (!pw) s.servers.push({ id: 'playwright', name: '浏览器(Playwright · 有窗口)', desc: '让 Claude 操作一个受控浏览器(有窗口可见 + 独立 profile,不影响你自己的 Chrome);要后台静默跑,可在 args 里加 --headless', enabled: false, transport: 'stdio', command: pwIso.command, args: pwIso.args, builtin: true });
  else { pw.command = pwIso.command; pw.args = pwIso.args; pw.transport = 'stdio'; pw.builtin = true; }
  // 浏览器:后台 · 保留登录(像 Codex App 那样)——用系统 Chrome + 一个独立持久化 profile。
  // 首次启用后会弹出一个独立 Chrome 窗口,你在里面把需要的网站登录一次,登录态就一直记在这个 profile 里;
  // 之后 Playwright 全程用 CDP 驱动页面(注入合成事件),【不动你的真实鼠标键盘】,也【不碰你日常那个 Chrome】。
  // 想完全无窗口纯后台:登录过一次后,在 args 末尾加 '--headless' 即可。
  const PW_PROFILE = path.join(app.getPath('userData'), 'pw-chrome-profile');
  const pwBg = pwEntry(['--browser', 'chrome', '--user-data-dir', PW_PROFILE]);
  const pwbg = s.servers.find(x => x.id === 'browser-bg');
  if (!pwbg) s.servers.push({ id: 'browser-bg', name: '浏览器(后台 · 保留登录)', desc: '用你的 Chrome 在独立窗口后台干活:保留登录态(独立 profile,首次在弹出的窗口登录一次),用 CDP 驱动不抢你的真实鼠标键盘,也不影响你日常的 Chrome;要完全无窗口可在 args 末尾加 --headless', enabled: false, transport: 'stdio', command: pwBg.command, args: pwBg.args, builtin: true });
  else { pwbg.command = pwBg.command; pwbg.args = pwBg.args; pwbg.transport = 'stdio'; pwbg.builtin = true; }
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
// 每个对话一份 MCP 配置文件,避免多对话并发时互相覆盖
function buildMcpConfigFile(convId, allow, includeEvolve) {
  const mcpServers = buildMcpServersObj(allow, includeEvolve);
  const name = 'gui-mcp-' + convId + '.json';
  writeJson(name, { mcpServers });
  return { path: dataFile(name), sig: JSON.stringify(mcpServers) };
}

// ===================== 对话存储 =====================
// 内存缓存 + 写盘 debounce:对话是最热的读写路径(每轮 / 每次切换都碰),
// 全程整文件 read+parse+write 会让主进程同步卡顿。缓存一份,写盘合并到 300ms,退出时强制落盘。
let _convCache = null, _convFlushTimer = null;
function loadConvs() {
  if (!_convCache) { _convCache = readJson('conversations.json', { list: [] }); if (!Array.isArray(_convCache.list)) _convCache.list = []; }
  return _convCache;
}
function flushConvs() { if (_convFlushTimer) { clearTimeout(_convFlushTimer); _convFlushTimer = null; } if (_convCache) { try { writeJson('conversations.json', _convCache); } catch {} } }
function saveConvs(s) { _convCache = s; if (_convFlushTimer) return; _convFlushTimer = setTimeout(() => { _convFlushTimer = null; flushConvs(); }, 300); }
const getConv = (id) => loadConvs().list.find(c => c.id === id);
function publicConvList() { return loadConvs().list.map(c => ({ id: c.id, title: c.title || (c.kind === 'plugin' ? '新插件' : '新对话'), updatedAt: c.updatedAt || 0, kind: c.kind || 'chat', pluginId: c.pluginId || null, agentId: c.agentId || null })).sort((a, b) => b.updatedAt - a.updatedAt); }
function createConv(kind) { const s = loadConvs(); const c = { id: genId('c'), kind: kind || 'chat', pluginId: null, title: '', sessionId: null, messages: [], updatedAt: Date.now() }; s.list.push(c); saveConvs(s); return c; }
function convForPlugin(pluginId, name) {
  const s = loadConvs();
  let c = s.list.find(x => x.pluginId === pluginId);
  if (!c) { c = { id: genId('c'), kind: 'plugin', pluginId, title: name || '插件', sessionId: null, messages: [], updatedAt: Date.now() }; s.list.push(c); saveConvs(s); }
  return c;
}
function deleteConv(id) { const s = loadConvs(); s.list = s.list.filter(c => c.id !== id); saveConvs(s); try { fs.unlinkSync(dataFile('gui-mcp-' + id + '.json')); } catch {} }
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

// ===================== 常驻对话引擎(每个对话一个独立进程,互不打架) =====================
// 每个 convId 对应一个 { proc, sessionId, ready, busy, run, buf, mcpSig, startServerIds, allow, isEvolve }
const engines = new Map();
const ENGINE_IDLE_MS = 10 * 60 * 1000; // 空闲超过 10 分钟的常驻引擎自动回收(下次发消息用 --resume 秒续)
const MAX_LIVE_ENGINES = 3;            // 常驻引擎数量上限;超出则回收最久未用的空闲引擎
let lastViewedConv = null;             // 渲染层最近打开/发消息的对话,它的引擎不回收

function killEngine(convId) {
  const e = engines.get(convId);
  if (!e) return;
  engines.delete(convId);
  // 立刻把这一对话当作"已中断"收尾:落盘已收到的中间结果 + 发 engine-done 解锁界面。
  // 关键:Windows 上 shell:true 起的 claude 是 cmd 的孙子进程,只 kill 掉 cmd 壳
  // 并不会停掉 claude,它还占着 stdout 管道 → 子进程的 'close' 迟迟不来 → 界面永远卡在"思考中"。
  // 所以这里主动收尾,不再傻等 close。
  if (e.run && e.busy) finishTurn(e, true);
  const proc = e.proc;
  if (proc) {
    try { proc.stdin.end(); } catch {}
    // 整棵进程树都杀掉(cmd → claude → 各 MCP 子进程),否则 claude 会变孤儿继续在后台跑(还可能继续操作鼠标/浏览器)
    if (process.platform === 'win32' && proc.pid) {
      try { spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']); } catch {}
    }
    try { proc.kill(); } catch {}
  }
}
function killAllEngines() { for (const id of Array.from(engines.keys())) killEngine(id); }

// 引擎是否可被回收:不忙、非当前查看、且没在跑 Agent Loop
function engineRecyclable(convId) {
  const e = engines.get(convId);
  if (!e || e.busy) return false;
  if (convId === lastViewedConv) return false;
  const lp = loops.get(convId);
  if (lp && lp.active) return false;
  return true;
}
// 回收:① 空闲超时的;② 数量超限时,挑最久未用的可回收引擎砍掉
function reapEngines() {
  const now = Date.now();
  for (const id of Array.from(engines.keys())) {
    if (engineRecyclable(id) && now - (engines.get(id).lastUsed || 0) > ENGINE_IDLE_MS) killEngine(id);
  }
  if (engines.size > MAX_LIVE_ENGINES) {
    const cand = Array.from(engines.keys()).filter(engineRecyclable)
      .map(id => ({ id, t: engines.get(id).lastUsed || 0 })).sort((a, b) => a.t - b.t);
    let over = engines.size - MAX_LIVE_ENGINES;
    for (const c of cand) { if (over <= 0) break; killEngine(c.id); over--; }
  }
}

// 打开/预热某对话的常驻进程(已开则复用)
function openEngine(convId) {
  if (engines.has(convId)) return;
  const conv = getConv(convId);
  if (!conv) return;
  reapEngines(); // 新开一个前先腾地方,避免常驻进程越积越多

  const isEvolve = conv.kind === 'evolve';
  const allow = isEvolve ? null : agentAllowSet(convId);
  const cfg = buildMcpConfigFile(convId, allow, isEvolve);
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
  const child = spawn('claude', args, { shell: true, cwd, env: buildEnv(), windowsHide: true });
  const e = {
    convId, proc: child, sessionId: conv.sessionId || null,
    ready: false, busy: false, run: null, buf: '',
    mcpSig: cfg.sig, startServerIds: loadMcp().servers.map(s => s.id),
    allow, isEvolve,
    lastUsed: Date.now(), errTail: '', gotOutput: false, silentTimer: null,
  };
  engines.set(convId, e);
  // 不再发 'warming' —— claude -p stream-json 要等到 stdin 第一条消息才会回 init,
  // 在那之前发 warming 会让 UI 卡在"预热中…"

  child.stdout.on('data', (d) => {
    e.buf += d.toString(); let idx;
    while ((idx = e.buf.indexOf('\n')) >= 0) { const l = e.buf.slice(0, idx).trim(); e.buf = e.buf.slice(idx + 1); if (l) onEngineLine(e, l); }
  });
  child.stderr.on('data', (d) => { e.errTail = (e.errTail + d.toString()).slice(-2000); }); // 留最近 2KB,失败时给用户看
  child.on('error', (err) => { send('engine-event', { convId, kind: 'system', text: 'spawn 失败: ' + err.message }); finishTurn(e, true); });
  child.on('close', (code) => {
    // 进程在一轮进行中意外退出且【什么都没产出】→ 多半是真失败(没登录/模型名错/baseUrl 挂了/网络断),
    // 把 stderr 里有意义的一行报给界面,别再静默卡住。(用户主动停止时 e.run 已清空,不会进这里)
    if (e.run && e.busy) {
      const r = e.run;
      const noOutput = !(r.resultText || (r.accText && r.accText.trim()) || (r.pending || []).some(p => p.type === 'assistant' || p.type === 'tool'));
      if (noOutput) send('engine-event', { convId, kind: 'system', text: '⚠️ ' + (pickErr(e.errTail) || ('claude 进程意外退出(code ' + code + ')')) });
      finishTurn(e, true);
    }
    if (engines.get(convId) === e) engines.delete(convId);
  });
}

function onEngineLine(e, line) {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const convId = e.convId;
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        if (msg.session_id) { e.sessionId = msg.session_id; setConvSession(convId, msg.session_id); }
        e.ready = true; send('engine-status', { convId, state: 'ready' });
      }
      break;
    case 'stream_event': {
      const ev = msg.event || {};
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        e.gotOutput = true;
        queueText(e, ev.delta.text);
      }
      break;
    }
    case 'assistant': {
      const blocks = (msg.message && msg.message.content) || [];
      for (const b of blocks) if (b.type === 'tool_use') { e.gotOutput = true; flushText(e); flushAssistant(e); if (e.run) e.run.pending.push({ type: 'tool', name: b.name, input: b.input }); send('engine-event', { convId, kind: 'tool', name: b.name, input: b.input }); }
      break;
    }
    case 'user': {
      const blocks = (msg.message && msg.message.content) || [];
      for (const b of blocks) if (b.type === 'tool_result') { let t = b.content; if (Array.isArray(t)) t = t.map(c => c.text || '').join(''); t = String(t || '').slice(0, 400); if (e.run) e.run.pending.push({ type: 'tool_result', text: t }); send('engine-event', { convId, kind: 'tool_result', text: t }); }
      break;
    }
    case 'result':
      if (msg.session_id) { e.sessionId = msg.session_id; setConvSession(convId, msg.session_id); }
      if (e.run) e.run.resultText = msg.result || '';
      flushText(e);
      flushAssistant(e);
      send('engine-event', { convId, kind: 'result', text: msg.result || '' });
      finishTurn(e, false);
      break;
  }
}
function flushAssistant(e) { if (e.run && e.run.accText.trim()) e.run.pending.push({ type: 'assistant', text: e.run.accText }); if (e.run) e.run.accText = ''; }
// 流式文本节流:把零碎的 token delta 合并到 ~30ms 再发一次,减少 IPC 次数与界面重排
function queueText(e, t) {
  if (!e.run) return;
  e.run.accText += t;              // 落盘用:整段累计
  e._txtBuf = (e._txtBuf || '') + t; // 发界面用:批量缓冲
  if (e._txtTimer) return;
  e._txtTimer = setTimeout(() => { e._txtTimer = null; const s = e._txtBuf; e._txtBuf = ''; if (s) send('engine-event', { convId: e.convId, kind: 'text', text: s }); }, 30);
}
function flushText(e) {
  if (e._txtTimer) { clearTimeout(e._txtTimer); e._txtTimer = null; }
  if (e._txtBuf) { const s = e._txtBuf; e._txtBuf = ''; send('engine-event', { convId: e.convId, kind: 'text', text: s }); }
}
// 从 stderr 尾巴里挑一条最有用的报错行
function pickErr(s) {
  if (!s) return '';
  const lines = s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const key = [...lines].reverse().find(l => /(error|invalid|unauthor|forbidden|denied|not\s*found|enoent|api[\s_-]*key|token|model|quota|rate\s*limit|fail|拒绝|无效|未登录|超时)/i.test(l));
  return (key || lines[lines.length - 1] || '').slice(0, 300);
}
function finishTurn(e, aborted) {
  flushText(e);
  if (e.silentTimer) { clearTimeout(e.silentTimer); e.silentTimer = null; }
  if (!e.run) { send('engine-done', { convId: e.convId, aborted: !!aborted }); return; }
  flushAssistant(e);
  const convId = e.run.convId;
  const resultText = e.run.resultText || '';
  appendMessages(convId, e.run.pending);
  e.run = null; e.busy = false; e.lastUsed = Date.now();
  let reload = false;
  if (!aborted) {
    const cur = JSON.stringify(buildMcpServersObj(e.allow, e.isEvolve));
    if (cur !== e.mcpSig) {
      reload = true;
      // 若当前是「未绑定的插件对话」,把本轮新造出来的插件绑到它身上(成为这个插件的家)
      const conv0 = getConv(convId);
      if (conv0 && conv0.kind === 'plugin' && !conv0.pluginId) {
        const startIds = e.startServerIds || [];
        const newSrv = loadMcp().servers.find(s => !s.builtin && !startIds.includes(s.id));
        if (newSrv) { const st = loadConvs(); const cc = st.list.find(x => x.id === convId); if (cc) { cc.pluginId = newSrv.id; cc.title = newSrv.name; saveConvs(st); } }
      }
      send('mcp-updated', publicMcp());
    }
  }
  send('engine-done', { convId, conversations: publicConvList(), aborted: !!aborted });
  if (reload) { send('engine-event', { convId, kind: 'system', text: '🧩 插件已更新,正在重载,稍后即可使用…' }); killEngine(convId); openEngine(convId); return; }
  // —— agent loop:worker 一轮结束 → 交给审查/验收 ——
  const lp = loops.get(convId);
  if (lp && lp.active && !aborted) loopAfterWorker(convId, resultText);
  // —— 自我进化:本轮结束后执行挂起的重载/重启 ——
  maybeDoEvolveReload();
}

function engineSend(convId, prompt) {
  let e = engines.get(convId);
  if (e && e.busy) { send('engine-event', { convId, kind: 'system', text: '引擎忙,请等当前任务结束。' }); return; }
  if (!getConv(convId)) return;
  if (!e) { openEngine(convId); e = engines.get(convId); }
  if (!e || !e.proc) { send('engine-event', { convId, kind: 'system', text: '引擎未启动。' }); return; }
  e.busy = true;
  e.lastUsed = Date.now(); lastViewedConv = convId; e.gotOutput = false;
  e.run = { convId, pending: [{ type: 'user', text: prompt }], accText: '' };
  if (e.silentTimer) clearTimeout(e.silentTimer);
  e.silentTimer = setTimeout(() => { if (e.busy && !e.gotOutput) send('engine-event', { convId, kind: 'system', text: '⏳ 已等待 60 秒仍无响应(可能在等网络/工具)。如卡住可按 ⏹ 中断。' }); }, 60000);
  const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n';
  try { e.proc.stdin.write(payload); } catch (err) { send('engine-event', { convId, kind: 'system', text: '写入失败: ' + err.message }); finishTurn(e, true); }
}

// ===================== 自我进化:重载桥 + git 基线 =====================
const EVOLVE_SIGNAL = () => path.join(app.getPath('userData'), '.evolve-signal.json');
let pendingEvolveReload = null; // 'reload' | 'restart'
function maybeDoEvolveReload() {
  if (!pendingEvolveReload) return;
  // 等进化对话(若存在)的引擎不忙再动,避免打断当前一轮
  const evolveConv = loadConvs().list.find(c => c.kind === 'evolve');
  if (evolveConv) {
    const ee = engines.get(evolveConv.id);
    if (ee && ee.busy) return;
  }
  const scope = pendingEvolveReload; pendingEvolveReload = null;
  if (scope === 'restart') {
    const r = dialog.showMessageBoxSync(mainWindow, { type: 'question', buttons: ['重启 App', '稍后'], defaultId: 0, cancelId: 1, message: '自我进化修改了主进程代码', detail: '需要重启 App 才能让 main.js / preload.js 的改动生效。现在重启?' });
    if (r === 0) { app.relaunch(); app.exit(0); }
  } else {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (evolveConv) send('engine-event', { convId: evolveConv.id, kind: 'system', text: '🧬 界面已重载,改动生效。' });
      mainWindow.webContents.reloadIgnoringCache();
    }
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

// 每个对话一个独立 loop 状态
const loops = new Map(); // convId -> { active, goal, iter, maxIter, withReviewer }
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
  const e = engines.get(convId);
  if (e && e.busy) { loopEvent({ convId, kind: 'error', text: '引擎忙,请等当前任务结束再启动循环。' }); return; }
  const lp = { active: true, convId, goal, iter: 1, maxIter: Math.max(1, Math.min(20, Number(maxIter) || 6)), withReviewer: withReviewer !== false };
  loops.set(convId, lp);
  loopEvent({ convId, kind: 'start', goal, maxIter: lp.maxIter, withReviewer: lp.withReviewer });
  const wp = `[Agent Loop 目标]\n${goal}\n\n这是一个自动循环任务。请朝这个目标做【实际操作】(可调用你的全部工具:插件 / 看屏幕 / 操作应用 / 浏览器等)。本轮做完后,会有一个独立验收员去【真实核实】是否达成;若未达成你会收到具体反馈再继续。本轮先尽力推进,并在结尾简要说明你做了什么、当前进展。`;
  engineSend(convId, wp);
}

async function loopAfterWorker(convId, resultText) {
  const lp = loops.get(convId);
  if (!lp || !lp.active) return;
  const summary = resultText && resultText.trim() ? resultText.trim().slice(0, 4000) : '(执行者无文字总结,请直接核实真实结果)';
  let issues = '';
  if (lp.withReviewer) {
    loopEvent({ convId, kind: 'reviewing', iter: lp.iter });
    issues = await runOneShot(REVIEWER_SYS, `目标:\n${lp.goal}\n\n执行者本轮的产出/说明:\n${summary}\n\n请审查这一轮的工作。`);
    const cur = loops.get(convId); if (!cur || !cur.active) return;
    loopEvent({ convId, kind: 'review', iter: lp.iter, text: issues });
  }
  loopEvent({ convId, kind: 'grading', iter: lp.iter });
  const gtext = await runOneShot(GRADER_SYS, `目标:\n${lp.goal}\n\n执行者本轮的产出/说明:\n${summary}\n\n请独立核实目标是否真的达成,只输出一行 JSON。`);
  const cur = loops.get(convId); if (!cur || !cur.active) return;
  const v = parseVerdict(gtext);
  loopEvent({ convId, kind: 'verdict', iter: lp.iter, met: v.met, score: v.score, feedback: v.feedback });
  if (v.met) { lp.active = false; loops.delete(convId); loopEvent({ convId, kind: 'done', met: true, iter: lp.iter }); return; }
  if (lp.iter >= lp.maxIter) { lp.active = false; loops.delete(convId); loopEvent({ convId, kind: 'done', met: false, iter: lp.iter, reason: 'maxIter' }); return; }
  lp.iter++;
  loopEvent({ convId, kind: 'next', iter: lp.iter });
  const cont = `[验收未通过 · 进入第 ${lp.iter} 轮]\n验收员反馈:${v.feedback || '(无)'}\n${lp.withReviewer ? '审查员意见:' + (issues || '(无)') + '\n' : ''}请据此继续推进并修正问题。目标重申:${lp.goal}`;
  engineSend(convId, cont);
}
function stopLoop(convId) {
  if (convId) {
    const lp = loops.get(convId);
    if (lp && lp.active) { lp.active = false; loops.delete(convId); loopEvent({ convId, kind: 'done', met: false, reason: 'stopped' }); }
  } else {
    for (const [cid, lp] of Array.from(loops.entries())) {
      if (lp.active) { lp.active = false; loops.delete(cid); loopEvent({ convId: cid, kind: 'done', met: false, reason: 'stopped' }); }
    }
  }
}

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
    width: 1080, height: 780, minWidth: 820, minHeight: 560, title: 'Claude Code++', backgroundColor: '#faf9f5',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}
app.whenReady().then(() => { try { saveMcp(loadMcp()); } catch {} createWindow(); watchEvolveSignal(); setInterval(reapEngines, 60 * 1000); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('window-all-closed', () => { flushConvs(); stopLoop(); stopWorkflow(); killAllEngines(); if (process.platform !== 'darwin') app.quit(); });

// ===================== IPC =====================
ipcMain.on('run-prompt', (_e, { conversationId, prompt }) => engineSend(conversationId, String(prompt || '')));
ipcMain.on('engine-open', (_e, convId) => { if (convId) { lastViewedConv = convId; openEngine(convId); } });
// 中断/引导:杀掉这一对话当前的 claude 子进程(它会触发 finishTurn(aborted),把已收到的中间结果存盘),
// 用户可立即接着输入新方向 —— 下一次 send 会用 --resume 拉同一个 session 继续。
ipcMain.on('engine-stop', (_e, convId) => { if (convId) killEngine(convId); });
ipcMain.on('loop:run', (_e, { convId, goal, maxIter, withReviewer }) => { if (convId && goal && String(goal).trim()) startLoop(convId, String(goal).trim(), maxIter, withReviewer); });
ipcMain.on('loop:stop', (_e, convId) => stopLoop(convId || null));

ipcMain.handle('conv:list', () => publicConvList());
ipcMain.handle('conv:get', (_e, id) => { const c = getConv(id); return c ? { id: c.id, title: c.title || '', kind: c.kind || 'chat', pluginId: c.pluginId || null, agentId: c.agentId || null, messages: c.messages || [] } : null; });
ipcMain.handle('conv:create', (_e, arg) => { const kind = (arg && typeof arg === 'object') ? arg.kind : arg; const agentId = (arg && typeof arg === 'object') ? arg.agentId : null; const k = (kind === 'plugin' || kind === 'evolve') ? kind : 'chat'; if (k === 'evolve') ensureGitBaseline(); const c = createConv(k); if (agentId) setConvAgent(c.id, agentId); return { conv: { id: c.id, title: '', kind: c.kind, agentId: agentId || null, messages: [] }, conversations: publicConvList() }; });
ipcMain.handle('conv:forPlugin', (_e, { pluginId, name }) => { const c = convForPlugin(pluginId, name); return { conv: { id: c.id, title: c.title || name || '插件', kind: 'plugin', pluginId, messages: c.messages || [] }, conversations: publicConvList() }; });
ipcMain.handle('conv:setAgent', (_e, { convId, agentId }) => { if (!getConv(convId)) return null; setConvAgent(convId, agentId); stopLoop(convId); if (engines.has(convId)) { killEngine(convId); openEngine(convId); } return { id: convId, agentId: agentId || null }; });
ipcMain.handle('conv:delete', (_e, id) => { stopLoop(id); killEngine(id); deleteConv(id); return publicConvList(); });

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
  // 所有正用这个 Agent 的活跃对话,统统热重载
  for (const c of loadConvs().list) {
    if (c.agentId === a.id && engines.has(c.id)) { killEngine(c.id); openEngine(c.id); }
  }
  return publicAgents();
});
ipcMain.handle('agents:remove', (_e, id) => {
  const s = loadAgents(); s.agents = s.agents.filter(a => a.id !== id || a.builtin); saveAgents(s);
  // 解绑用到它的对话
  const cs = loadConvs(); let changed = false;
  for (const c of cs.list) if (c.agentId === id) { c.agentId = null; changed = true; }
  if (changed) saveConvs(cs);
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
ipcMain.handle('providers:setActive', (_e, id) => { const s = loadProviders(); if (s.profiles.find(p => p.id === id)) { s.activeId = id; saveProviders(s); stopLoop(); stopWorkflow(); killAllEngines(); } return publicProfiles(); });

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

// ---- Skills(本机 Claude Code skills 列表) ----
function parseSkillFrontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const fm = text.slice(3, end).split(/\r?\n/);
  const out = {}; let key = null; let buf = [];
  const flush = () => { if (key) out[key] = buf.join('\n').trim(); };
  for (const line of fm) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (m) { flush(); key = m[1]; buf = m[2] ? [m[2]] : []; }
    else if (key && (line.startsWith('  ') || line.startsWith('\t'))) { buf.push(line.replace(/^\s+/, '')); }
  }
  flush();
  return out;
}
function listInstalledSkills() {
  const skillsDir = path.join(os.homedir(), '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) return { dir: skillsDir, items: [] };
  const items = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(skillsDir, entry.name);
    let realPath = full; let isLink = false;
    try { const lst = fs.lstatSync(full); isLink = lst.isSymbolicLink(); if (isLink) realPath = fs.realpathSync(full); } catch {}
    const md = path.join(realPath, 'SKILL.md');
    let name = entry.name, description = '', hasMd = false;
    if (fs.existsSync(md)) {
      hasMd = true;
      try {
        const text = fs.readFileSync(md, 'utf8');
        const fm = parseSkillFrontmatter(text);
        if (fm.name) name = String(fm.name).trim();
        if (fm.description) description = String(fm.description).replace(/\s+/g, ' ').trim();
      } catch {}
    }
    items.push({ dirName: entry.name, name, description, isLink, source: realPath, skillFile: md, hasMd });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { dir: skillsDir, items };
}
ipcMain.handle('skills:list', () => listInstalledSkills());
ipcMain.handle('skills:reveal', (_e, p) => { try { shell.showItemInFolder(p); return true; } catch { return false; } });
ipcMain.handle('skills:open', (_e, p) => { try { shell.openPath(p); return true; } catch { return false; } });

// ===================== 终端模式 (真 PTY,跑原生 claude CLI 的完整 TUI) =====================
// 普通"对话引擎"用 -p stream-json,CLI 自己判定为非交互,/permissions / /login / /help 等斜杠命令全部不可用。
// 这里给它一个伪终端,xterm.js 渲染,完整 TUI 体验。
let _pty = null; let _ptyErr = null;
function loadPty() {
  if (_pty || _ptyErr) return _pty;
  try { _pty = require('node-pty'); } catch (e) { _ptyErr = e; }
  return _pty;
}
function resolveClaudeExe() {
  const PATHEXT = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map(s => s.trim()).filter(Boolean);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of PATHEXT) {
      const p = path.join(dir, 'claude' + ext);
      try { if (fs.existsSync(p)) return p; } catch {}
    }
    // 无后缀(类 Unix 安装)
    const bare = path.join(dir, 'claude');
    try { if (fs.existsSync(bare)) return bare; } catch {}
  }
  return null;
}

// 每个会话一个 pty;key 由 renderer 指定,默认就 "main" 一个全局终端
const ptys = new Map(); // sessionId -> { proc, cwd }

function ptyKill(sessionId) {
  const s = ptys.get(sessionId); if (!s) return;
  try { s.proc.kill(); } catch {}
  ptys.delete(sessionId);
}

ipcMain.handle('cli:check', () => {
  const mod = loadPty();
  const exe = resolveClaudeExe();
  return { available: !!mod && !!exe, claudePath: exe, error: _ptyErr ? String(_ptyErr.message || _ptyErr) : (!exe ? '在 PATH 里没找到 claude 可执行文件' : '') };
});

ipcMain.handle('cli:open', (_e, { sessionId, cols, rows, cwd }) => {
  const id = sessionId || 'main';
  const mod = loadPty();
  if (!mod) return { ok: false, error: 'node-pty 加载失败: ' + String(_ptyErr && _ptyErr.message || _ptyErr) };
  const exe = resolveClaudeExe();
  if (!exe) return { ok: false, error: '在 PATH 里没找到 claude 可执行文件' };
  // 已存在且活着:直接复用
  const existing = ptys.get(id);
  if (existing && existing.proc && !existing.proc.killed) {
    try { existing.proc.resize(Math.max(20, cols | 0), Math.max(4, rows | 0)); } catch {}
    return { ok: true, reused: true, claudePath: exe, cwd: existing.cwd };
  }
  const workDir = (cwd && fs.existsSync(cwd)) ? cwd : (app.getPath('home') || PROJECT_DIR);
  let proc;
  try {
    proc = mod.spawn(exe, [], {
      name: 'xterm-256color',
      cols: Math.max(20, cols | 0) || 100,
      rows: Math.max(4, rows | 0) || 30,
      cwd: workDir,
      env: { ...buildEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
  } catch (e) { return { ok: false, error: 'spawn 失败: ' + (e.message || e) }; }
  ptys.set(id, { proc, cwd: workDir });
  proc.onData((data) => { send('cli:data', { sessionId: id, data }); });
  proc.onExit(({ exitCode, signal }) => {
    if (ptys.get(id) && ptys.get(id).proc === proc) ptys.delete(id);
    send('cli:exit', { sessionId: id, exitCode, signal });
  });
  return { ok: true, reused: false, claudePath: exe, cwd: workDir };
});

ipcMain.on('cli:write', (_e, { sessionId, data }) => {
  const s = ptys.get(sessionId || 'main'); if (!s) return;
  try { s.proc.write(data); } catch {}
});
ipcMain.on('cli:resize', (_e, { sessionId, cols, rows }) => {
  const s = ptys.get(sessionId || 'main'); if (!s) return;
  try { s.proc.resize(Math.max(20, cols | 0), Math.max(4, rows | 0)); } catch {}
});
ipcMain.on('cli:close', (_e, { sessionId }) => ptyKill(sessionId || 'main'));

app.on('before-quit', () => { flushConvs(); for (const id of Array.from(ptys.keys())) ptyKill(id); });
