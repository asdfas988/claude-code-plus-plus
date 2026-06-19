'use strict';

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let currentConvId = null;
let convCache = [];
let assistantBodyEl = null;
let busy = false;
// 每个对话独立追踪是否在跑/在循环。busy/looping 始终等于这两个集合对当前对话的查询结果。
const busyConvs = new Set();
const loopingConvs = new Set();
function syncFromCurrent() {
  busy = currentConvId ? busyConvs.has(currentConvId) : false;
  looping = currentConvId ? loopingConvs.has(currentConvId) : false;
}

// ===================== 页面导航 =====================
const pages = { chat: $('page-chat'), providers: $('page-providers'), plugins: $('page-plugins'), agents: $('page-agents'), workflows: $('page-workflows'), skills: $('page-skills'), terminal: $('page-terminal') };
const navBtns = document.querySelectorAll('.nav-btn');
function showPage(name) {
  Object.values(pages).forEach(p => p.classList.remove('active'));
  pages[name].classList.add('active');
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.page === name));
  if (name === 'providers') refreshProviders();
  if (name === 'plugins') refreshMcp();
  if (name === 'agents') refreshAgents();
  if (name === 'workflows') refreshWorkflows();
  if (name === 'skills') refreshSkills();
  if (name === 'terminal') openTerminalPage();
  $('top-title').textContent = name === 'providers' ? '服务商' : name === 'plugins' ? '插件与 MCP' : name === 'agents' ? 'Agent 管理' : name === 'workflows' ? '团队 / 工作流' : name === 'skills' ? 'Skills' : name === 'terminal' ? '终端' : (currentTitle() || '新对话');
}
navBtns.forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));
function currentTitle() { const c = convCache.find(x => x.id === currentConvId); return c ? c.title : ''; }

// ===================== 引擎状态指示 =====================
const stateEl = $('engine-state');
// 带旋转小圈的忙碌态(终端风格);同时在对话区里挂一个"Claude 思考中…"气泡。
// inChat=false 时只动顶栏(用于预热这种非用户触发的状态,避免给空对话凭空塞气泡)
function setBusy(text, inChat = true) {
  stateEl.style.display = '';
  stateEl.classList.add('busy');
  stateEl.innerHTML = '<span class="spinner"></span><span></span>';
  stateEl.lastChild.textContent = text;
  if (inChat) showThinkingInChat(text); else hideThinkingInChat();
}
// 不带圈的静态状态(就绪/完成提示等)
function setIdle(text) {
  stateEl.style.display = '';
  stateEl.classList.remove('busy');
  stateEl.textContent = text;
  hideThinkingInChat();
}
function hideState() {
  stateEl.classList.remove('busy');
  stateEl.style.display = 'none';
  stateEl.textContent = '';
  hideThinkingInChat();
}
window.agent.onStatus((d) => {
  if (d.convId !== currentConvId) return;
  // 不再有 warming —— claude -p stream-json 要等 stdin 第一条消息才回 init,
  // 提前发 warming 会让 UI 永远卡在"预热中…"。ready 也只是过场,不忙时一闪而过。
  if (d.state === 'ready' && !busy && !looping) {
    setIdle('🟢 就绪');
    setTimeout(() => { if (!busy && !looping) hideState(); }, 1200);
  }
});

// ===================== 侧栏 · 对话 + 插件 两栏 =====================
let currentConvKind = 'chat';
function makeItem(c) {
  const item = document.createElement('div');
  item.className = 'conv-item' + (c.id === currentConvId ? ' active' : '');
  const title = document.createElement('div'); title.className = 'conv-title';
  const pfx = c.kind === 'plugin' ? '🧩 ' : c.kind === 'evolve' ? '🧬 ' : '';
  title.textContent = pfx + (c.title || (c.kind === 'plugin' ? '新插件' : c.kind === 'evolve' ? '自我进化' : '新对话'));
  const del = document.createElement('button'); del.className = 'conv-del'; del.textContent = '🗑'; del.title = '删除';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(c.kind === 'plugin' ? '删除这个插件对话?(插件本身仍可在「插件与 MCP 开关」里管理)' : '删除这个对话?')) return;
    convCache = await window.conv.remove(c.id);
    if (currentConvId === c.id) { const first = convCache.find(x => x.kind !== 'plugin') || convCache[0]; currentConvId = first ? first.id : null; if (currentConvId) openConv(currentConvId); else newConversation(); }
    renderSidebar();
  });
  item.appendChild(title); item.appendChild(del);
  item.addEventListener('click', () => openConv(c.id));
  return item;
}
function renderSidebar() {
  const chats = convCache.filter(c => c.kind !== 'plugin');
  const plugins = convCache.filter(c => c.kind === 'plugin');
  const cl = $('conv-list'); cl.innerHTML = '';
  if (!chats.length) cl.innerHTML = '<div class="empty-hint">还没有对话,点「新建对话」。</div>';
  else chats.forEach(c => cl.appendChild(makeItem(c)));
  const pl = $('plugin-list'); pl.innerHTML = '';
  if (!plugins.length) pl.innerHTML = '<div class="empty-hint">点右上 ＋,在对话里让 Claude 造一个插件。</div>';
  else plugins.forEach(c => pl.appendChild(makeItem(c)));
}

async function openConv(id) {
  currentConvId = id;
  showPage('chat'); renderSidebar();
  const conv = await window.conv.get(id);
  currentConvKind = (conv && conv.kind) || 'chat';
  $('top-title').textContent = (conv && conv.title) || (currentConvKind === 'plugin' ? '新插件' : '新对话');
  syncAgentPicker(conv ? conv.agentId : null, currentConvKind);
  renderMessages(conv ? conv.messages : [], currentConvKind);
  assistantBodyEl = null;
  // 切换对话 → 把 UI 同步到这条对话自己的状态(忙/在循环/或空闲)
  loopMode = false;
  inputEl.placeholder = PH_DEFAULT;
  syncFromCurrent();
  refreshSendUI();
  if (looping) setBusy('Agent Loop 运行中…');
  else if (busy) setBusy('思考中…');
  else hideState();
  window.agent.open(id);
}
function resetChatUIForFreshConv() {
  assistantBodyEl = null;
  loopMode = false; inputEl.placeholder = PH_DEFAULT;
  syncFromCurrent();
  refreshSendUI();
  hideState();
}
async function newConversation() {
  const r = await window.conv.create('chat');
  convCache = r.conversations; currentConvId = r.conv.id; currentConvKind = 'chat';
  showPage('chat'); renderSidebar();
  $('top-title').textContent = '新对话'; syncAgentPicker(null, 'chat'); renderMessages([], 'chat');
  resetChatUIForFreshConv();
  window.agent.open(currentConvId);
  $('input').focus();
}
async function newPlugin() {
  const r = await window.conv.create('plugin');
  convCache = r.conversations; currentConvId = r.conv.id; currentConvKind = 'plugin';
  showPage('chat'); renderSidebar();
  $('top-title').textContent = '新插件'; syncAgentPicker(null, 'plugin'); renderMessages([], 'plugin');
  resetChatUIForFreshConv();
  window.agent.open(currentConvId);
  $('input').focus();
}
async function openEvolve() {
  // 复用已有的进化对话(若有),否则新建
  const existing = convCache.find(c => c.kind === 'evolve');
  if (existing) { openConv(existing.id); return; }
  const r = await window.conv.create('evolve');
  convCache = r.conversations; currentConvId = r.conv.id; currentConvKind = 'evolve';
  showPage('chat'); renderSidebar();
  $('top-title').textContent = '自我进化'; syncAgentPicker(null, 'evolve'); renderMessages([], 'evolve');
  resetChatUIForFreshConv();
  window.agent.open(currentConvId);
  $('input').focus();
}
$('new-chat').addEventListener('click', newConversation);
$('new-plugin').addEventListener('click', newPlugin);
$('nav-evolve').addEventListener('click', openEvolve);
$('evolve-rollback').addEventListener('click', async () => {
  if (!confirm('回滚上一次自我进化(撤销最近一次改动并重载)?')) return;
  const r = await window.evolve.rollback();
  appendLive({ type: 'system', text: (r && r.ok ? '🧬 ' : '⚠️ ') + (r ? r.msg : '回滚失败') });
});

// ===================== 对话渲染 =====================
const logEl = $('log');
// 滚动节流:流式文本一来就 scrollTop=scrollHeight 会反复触发重排;用 rAF 合并到每帧一次
let _scrollQueued = false;
function scrollLog() { if (_scrollQueued) return; _scrollQueued = true; requestAnimationFrame(() => { _scrollQueued = false; logEl.scrollTop = logEl.scrollHeight; }); }
function renderMessages(msgs, kind) {
  logEl.innerHTML = ''; assistantBodyEl = null;
  if (!msgs || !msgs.length) {
    if (kind === 'evolve') {
      logEl.innerHTML = '<div class="welcome"><h2>自我进化 🧬</h2><div>这里你直接和 App 对话，让它<b>改自己</b>：加功能、改界面、调设计。例如:<br>「把发送按钮改成蓝色」<br>「在顶栏加一个一键导出当前对话的按钮」<br>「新增一个深色/浅色主题切换」<br>每次改动前会自动 git 快照，不满意点右上「↶ 回滚上次进化」即可。<br>界面改动会软重载即时生效；主进程(main.js)改动会让你确认后重启。</div></div>';
    } else if (kind === 'plugin') {
      logEl.innerHTML = '<div class="welcome"><h2>造一个插件 🧩</h2><div>直接说你想要什么能力,我来写好并装上。例如:<br>「做一个能读写桌面文本文件的插件」<br>「帮我装个 Playwright 浏览器插件」<br>造好后在这条里就能直接用它,也能继续说「再加个 XX 功能」。</div></div>';
    } else {
      logEl.innerHTML = '<div class="welcome"><h2>有什么可以帮你的?</h2><div>我能驱动你的电脑:看屏幕、移动鼠标点击、操作窗口、控制浏览器,以及调用你装的各种插件。</div></div>';
    }
    return;
  }
  const wrap = document.createElement('div'); wrap.className = 'msg-wrap';
  msgs.forEach(m => wrap.appendChild(buildMsgEl(m)));
  logEl.appendChild(wrap); logEl.scrollTop = logEl.scrollHeight;
}
function buildMsgEl(m) {
  if (m.type === 'user') { const d = document.createElement('div'); d.className = 'msg user'; d.innerHTML = `<div class="who">你</div><div class="bubble">${escapeHtml(m.text)}</div>`; return d; }
  if (m.type === 'assistant') { const d = document.createElement('div'); d.className = 'msg assistant'; d.innerHTML = `<div class="who">Claude</div><div class="body">${escapeHtml(m.text)}</div>`; return d; }
  if (m.type === 'tool') { const d = document.createElement('div'); const a = m.input ? ' ' + JSON.stringify(m.input) : ''; d.className = 'pill'; d.textContent = '🔧 调用工具 ' + m.name + a; return d; }
  if (m.type === 'tool_result') { const d = document.createElement('div'); d.className = 'pill result'; d.textContent = '↳ ' + m.text; return d; }
  const d = document.createElement('div'); d.className = 'sys-line'; d.textContent = m.text || ''; return d;
}
function ensureWrap() { let w = logEl.querySelector('.msg-wrap'); if (!w) { logEl.innerHTML = ''; w = document.createElement('div'); w.className = 'msg-wrap'; logEl.appendChild(w); } return w; }
function appendLive(m) { if (logEl.querySelector('.welcome')) logEl.innerHTML = ''; ensureWrap().appendChild(buildMsgEl(m)); scrollLog(); }

// 对话区内嵌的"思考中"气泡(终端风格小圈 + 文案),由 setBusy / hideState 同步驱动
function showThinkingInChat(text) {
  hideThinkingInChat();
  if (logEl.querySelector('.welcome')) logEl.innerHTML = '';
  const w = ensureWrap();
  const d = document.createElement('div');
  d.className = 'msg assistant thinking-msg';
  d.innerHTML = '<div class="who">Claude</div><div class="thinking-bubble"><span class="spinner"></span><span class="t-txt"></span></div>';
  d.querySelector('.t-txt').textContent = text;
  w.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}
function hideThinkingInChat() {
  logEl.querySelectorAll('.thinking-msg').forEach(e => e.remove());
}

// ===================== 发送 + Agent Loop =====================
const inputEl = $('input'), sendBtn = $('send');
const autoBtn = $('auto-toggle');
let loopMode = false;   // 开关:把输入当「目标」交给 agent loop
let looping = false;    // 正在循环中(= loopingConvs.has(currentConvId))
let pendingGuide = null; // 生成中用户又发的「新方向」:中断当前一轮后自动续发(同一 session)
const LOOP_MAX = 6;     // 最多轮数
const LOOP_REVIEWER = true; // 三角色:含审查员
const PH_DEFAULT = '给 Claude 发消息……(Enter 发送,Shift+Enter 换行,生成中按 Esc 中断引导)';
const PH_LOOP = '输入一个【目标】(最好带可验证的完成标准)……我会自己循环推进直到达成';
const SEND_DEFAULT = '↑';

// 按钮状态根据 busy/looping/loopMode 同步;不再用 disabled 锁送,而是在忙时变 ⏹ 停止
function refreshSendUI() {
  if (looping) {
    sendBtn.textContent = '⏹';
    sendBtn.title = '停止 Agent Loop';
    sendBtn.classList.add('stop');
    sendBtn.disabled = false;
    autoBtn.textContent = '⏹ 停止循环';
    autoBtn.classList.add('looping');
    autoBtn.classList.remove('on');
  } else if (busy) {
    sendBtn.textContent = '⏹';
    sendBtn.title = '中断当前一轮(已收到的内容会保留,可立即输入新方向)';
    sendBtn.classList.add('stop');
    sendBtn.disabled = false;
    autoBtn.textContent = '🔁 Loop';
    autoBtn.classList.remove('looping');
    autoBtn.classList.toggle('on', loopMode);
  } else {
    sendBtn.textContent = SEND_DEFAULT;
    sendBtn.title = '发送';
    sendBtn.classList.remove('stop');
    sendBtn.disabled = false;
    autoBtn.textContent = '🔁 Loop';
    autoBtn.classList.remove('looping');
    autoBtn.classList.toggle('on', loopMode);
  }
}
function stopCurrent() {
  if (wfRunning) { window.workflows.stop(); return; }
  if (!currentConvId) return;
  if (looping) window.agent.loopStop(currentConvId);
  else if (busy) window.agent.stop(currentConvId);
}

autoBtn.addEventListener('click', () => {
  if (looping) { window.agent.loopStop(currentConvId); return; } // 循环中再点 = 停止
  if (busy) return; // 在跑普通对话时不让切模式,避免歧义
  loopMode = !loopMode;
  refreshSendUI();
  inputEl.placeholder = loopMode ? PH_LOOP : PH_DEFAULT;
});

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function appendLoopCard(cls, head, rows) {
  if (logEl.querySelector('.welcome')) logEl.innerHTML = '';
  hideThinkingInChat(); // 真实内容来了,撤掉思考气泡(下一个 busy 会再加一个新的)
  const w = ensureWrap();
  const d = document.createElement('div'); d.className = 'loop-card' + (cls ? ' ' + cls : '');
  let html = '<div class="lc-head">' + head + '</div>';
  for (const r of (rows || [])) if (r) html += '<div class="lc-row">' + r + '</div>';
  d.innerHTML = html; w.appendChild(d); logEl.scrollTop = logEl.scrollHeight;
}
function appendIter(n, max) {
  if (logEl.querySelector('.welcome')) logEl.innerHTML = '';
  const w = ensureWrap(); const d = document.createElement('div'); d.className = 'loop-iter';
  d.innerHTML = '<span>第 ' + n + ' / ' + max + ' 轮</span>'; w.appendChild(d); logEl.scrollTop = logEl.scrollHeight;
}
function endLoopUI() {
  if (currentConvId) { loopingConvs.delete(currentConvId); busyConvs.delete(currentConvId); }
  syncFromCurrent();
  assistantBodyEl = null;
  loopMode = false; inputEl.placeholder = PH_DEFAULT;
  refreshSendUI();
  hideState();
}

async function sendPrompt() {
  const text = inputEl.value.trim();
  if (!text) return;
  // 普通生成中又发消息 = 立刻中断当前一轮,并把这条作为「新方向」续接发出(同一 session,不丢上下文)
  if (busy && !looping && !wfRunning) {
    pendingGuide = text;
    inputEl.value = ''; inputEl.style.height = 'auto';
    appendLive({ type: 'system', text: '⏹ 正在中断当前回答,马上按你的新方向继续……' });
    stopCurrent();
    return;
  }
  if (looping || wfRunning) return; // 循环 / 工作流进行中:用 ⏹ 停止,不在此插入普通消息
  if (!currentConvId) await newConversation();
  appendLive({ type: 'user', text });
  inputEl.value = ''; inputEl.style.height = 'auto'; assistantBodyEl = null;
  busyConvs.add(currentConvId);
  if (loopMode) {
    loopingConvs.add(currentConvId);
    looping = true; busy = true;
    refreshSendUI();
    setBusy('Agent Loop 运行中…');
    window.agent.loopRun(currentConvId, text, LOOP_MAX, LOOP_REVIEWER);
  } else {
    busy = true;
    refreshSendUI();
    setBusy('思考中…');
    window.agent.run(currentConvId, text);
  }
}
sendBtn.addEventListener('click', () => {
  if (busy || looping) { stopCurrent(); return; }
  sendPrompt();
});
inputEl.addEventListener('keydown', (e) => {
  // Esc:在生成 / 循环中按下立刻中断,落地到一个干净状态,再键入即可"引导"它(下次 send 会 --resume 同一 session)
  if (e.key === 'Escape' && (busy || looping)) { e.preventDefault(); stopCurrent(); return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendPrompt(); }
});
inputEl.addEventListener('input', () => { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px'; });

window.agent.onEvent((d) => {
  // 任何一条引擎事件 = 那个对话正在跑 → 记到 busyConvs,这样切回去时 UI 还原得了
  if (d.convId) busyConvs.add(d.convId);
  if (d.convId && d.convId !== currentConvId) return; // 忽略非当前对话(仅追踪状态)
  switch (d.kind) {
    case 'text':
      if (!assistantBodyEl) {
        hideThinkingInChat(); // 真实回复来了,撤掉"思考中"气泡
        const w = ensureWrap(); const el = document.createElement('div'); el.className = 'msg assistant'; el.innerHTML = '<div class="who">Claude</div><div class="body"></div>'; w.appendChild(el); assistantBodyEl = el.querySelector('.body');
      }
      assistantBodyEl.textContent += d.text; scrollLog(); break;
    case 'tool': assistantBodyEl = null; hideThinkingInChat(); appendLive({ type: 'tool', name: d.name, input: d.input }); break;
    case 'tool_result': appendLive({ type: 'tool_result', text: d.text }); break;
    case 'system': appendLive({ type: 'system', text: d.text }); break;
    case 'result': assistantBodyEl = null; break;
  }
});
window.agent.onDone((d) => {
  if (d && d.conversations) { convCache = d.conversations; renderSidebar(); const c = convCache.find(x => x.id === currentConvId); if (c) $('top-title').textContent = c.title || (c.kind === 'plugin' ? '新插件' : '新对话'); }
  if (d && d.convId) busyConvs.delete(d.convId);
  // 非当前对话完成 → 别动 UI
  if (d && d.convId && d.convId !== currentConvId) return;
  assistantBodyEl = null;
  if (looping) { setBusy('本轮完成,审查 / 验收中…'); return; } // 循环中不解锁,交给 loop 事件
  syncFromCurrent();
  refreshSendUI();
  hideState();
  // 中断收尾后,若有挂起的「新方向」→ 自动按它续接;否则提示用户可直接输入新方向
  if (pendingGuide && !busy && !looping) {
    const g = pendingGuide; pendingGuide = null;
    inputEl.value = g;
    setTimeout(sendPrompt, 30);
  } else if (d && d.aborted) {
    appendLive({ type: 'system', text: '⏹ 已中断。直接输入新方向继续(会用同一 session 续接)。' });
  }
});

// Agent Loop 进度事件
window.agent.onLoop((d) => {
  // 先维护 per-conv 状态集合,再决定要不要动当前 UI
  if (d.convId) {
    if (d.kind === 'start') loopingConvs.add(d.convId);
    if (d.kind === 'done' || d.kind === 'error') loopingConvs.delete(d.convId);
  }
  if (d.convId && d.convId !== currentConvId) return;
  switch (d.kind) {
    case 'start':
      appendLoopCard('', '🔁 Agent Loop 启动', ['🎯 目标:' + esc(d.goal), '最多 ' + d.maxIter + ' 轮 · ' + (d.withReviewer ? '审查员 + 验收员把关' : '仅验收员把关')]);
      appendIter(1, d.maxIter); break;
    case 'reviewing': setBusy('审查员独立审查本轮…'); break;
    case 'review': appendLoopCard('', '🔍 审查员意见(独立上下文)', [esc(d.text)]); break;
    case 'grading': setBusy('验收员独立核实是否达成…'); break;
    case 'verdict':
      appendLoopCard(d.met ? 'pass' : 'fail', (d.met ? '✅ 验收通过' : '❌ 验收未通过') + (d.score ? ' · ' + d.score + ' 分' : ''), ['验收员:' + esc(d.feedback)]); break;
    case 'next': appendIter(d.iter, LOOP_MAX); setBusy('第 ' + d.iter + ' 轮推进中…'); break;
    case 'done':
      appendLoopCard(d.met ? 'pass' : 'fail', d.met ? '🎉 目标达成,循环结束' : (d.reason === 'stopped' ? '⏹ 已手动停止循环' : '🛑 已达最大轮数(' + (d.iter || LOOP_MAX) + ' 轮)仍未达成,停止'), []);
      endLoopUI(); break;
    case 'error': appendLoopCard('fail', '⚠️ ' + esc(d.text), []); endLoopUI(); break;
  }
});

// ===================== 服务商 =====================
const pf = { id: $('pf-id'), name: $('pf-name'), baseurl: $('pf-baseurl'), model: $('pf-model'), secrettype: $('pf-secrettype'), secret: $('pf-secret'), title: $('prov-form-title') };
function updateBadge(state) { const a = state.profiles.find(p => p.id === state.activeId); $('active-badge').textContent = '服务商:' + (a ? a.name : '默认'); }
function renderProviders(state) {
  updateBadge(state);
  const box = $('prov-list'); box.innerHTML = '';
  state.profiles.forEach(p => {
    const card = document.createElement('div'); card.className = 'card' + (p.id === state.activeId ? ' sel' : '');
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'ap'; radio.className = 'radio'; radio.checked = p.id === state.activeId;
    radio.addEventListener('change', async () => renderProviders(await window.providers.setActive(p.id)));
    const meta = [p.baseUrl || '官方端点']; if (p.model) meta.push('模型 ' + p.model);
    if (p.secretType !== 'none') meta.push(p.hasSecret ? p.secretType + ' ✓' : p.secretType + '（未设）');
    const info = document.createElement('div'); info.className = 'info';
    info.innerHTML = `<div class="nm">${escapeHtml(p.name)}${p.builtin ? '<span class="tag">内置</span>' : ''}</div><div class="meta">${escapeHtml(meta.join('  ·  '))}</div>`;
    card.appendChild(radio); card.appendChild(info);
    if (!p.builtin) {
      const e = document.createElement('button'); e.className = 'btn sm'; e.textContent = '编辑'; e.addEventListener('click', () => fillProv(p));
      const x = document.createElement('button'); x.className = 'btn sm danger'; x.textContent = '删除'; x.addEventListener('click', async () => renderProviders(await window.providers.remove(p.id)));
      card.appendChild(e); card.appendChild(x);
    }
    box.appendChild(card);
  });
}
function fillProv(p) { pf.id.value = p.id; pf.name.value = p.name; pf.baseurl.value = p.baseUrl || ''; pf.model.value = p.model || ''; pf.secrettype.value = p.secretType || 'none'; pf.secret.value = ''; pf.title.textContent = '编辑服务商:' + p.name; }
function resetProv() { pf.id.value = ''; pf.name.value = ''; pf.baseurl.value = ''; pf.model.value = ''; pf.secrettype.value = 'none'; pf.secret.value = ''; pf.title.textContent = '新增服务商'; }
$('pf-reset').addEventListener('click', resetProv);
$('pf-save').addEventListener('click', async () => {
  if (!pf.name.value.trim()) { alert('请填写名称'); return; }
  const state = await window.providers.save({ id: pf.id.value || undefined, name: pf.name.value, baseUrl: pf.baseurl.value, model: pf.model.value, secretType: pf.secrettype.value, secret: pf.secret.value });
  resetProv(); renderProviders(state);
});
async function refreshProviders() { renderProviders(await window.providers.list()); }

// ===================== 插件:仅开关 + 删除 =====================
function renderMcp(state) {
  const box = $('mcp-list'); box.innerHTML = '';
  state.servers.forEach(s => {
    const card = document.createElement('div'); card.className = 'card';
    const sw = document.createElement('label'); sw.className = 'switch';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = s.enabled;
    cb.addEventListener('change', async () => renderMcp(await window.mcp.toggle(s.id, cb.checked)));
    const sl = document.createElement('span'); sl.className = 'slider'; sw.appendChild(cb); sw.appendChild(sl);
    const detail = s.transport === 'http' ? s.url : [s.command].concat(s.args || []).join(' ');
    const info = document.createElement('div'); info.className = 'info';
    const tags = (s.builtin ? '<span class="tag">内置</span>' : '') + (s.ai ? '<span class="tag">AI 生成</span>' : '') + `<span class="tag">${s.transport}</span>`;
    info.innerHTML = `<div class="nm">${escapeHtml(s.name)}${tags}</div><div class="meta">${escapeHtml(s.desc ? s.desc + ' · ' : '')}${escapeHtml(detail || '')}</div>`;
    card.appendChild(sw); card.appendChild(info);
    if (!s.builtin) {
      const x = document.createElement('button'); x.className = 'btn sm danger'; x.textContent = '删除';
      x.addEventListener('click', async () => { if (confirm('删除插件「' + s.name + '」?')) renderMcp(await window.mcp.remove(s.id)); });
      card.appendChild(x);
    }
    box.appendChild(card);
  });
}
async function refreshMcp() { renderMcp(await window.mcp.list()); }
window.mcp.onUpdated((state) => renderMcp(state)); // 对话里造了插件 → 实时刷新列表

// ===================== 自定义 Agent =====================
let agentsCache = [];
const CORE_MCP = ['gui', 'pluginmgr', 'agentmgr']; // 核心内置,不作为可勾选插件(始终可用)
const agf = { id: $('ag-id'), emoji: $('ag-emoji'), name: $('ag-name'), sys: $('ag-sys'), model: $('ag-model'), plugins: $('ag-plugins'), title: $('agent-form-title') };

async function renderPluginChecks(selected) {
  const sel = new Set(selected || []);
  let servers = [];
  try { const st = await window.mcp.list(); servers = (st.servers || []).filter(s => !CORE_MCP.includes(s.id) && s.transport !== 'flag'); } catch {}
  agf.plugins.innerHTML = '';
  if (!servers.length) { agf.plugins.innerHTML = '<span style="color:var(--muted);font-size:12.5px">(暂无可选插件，去对话里让 Claude 造一个)</span>'; return; }
  servers.forEach(s => {
    const l = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = s.id; cb.checked = sel.has(s.id);
    l.appendChild(cb); l.appendChild(document.createTextNode(' ' + (s.name || s.id)));
    agf.plugins.appendChild(l);
  });
}
function readPluginChecks() {
  const boxes = agf.plugins.querySelectorAll('input[type=checkbox]');
  const checked = [...boxes].filter(b => b.checked).map(b => b.value);
  // 一个都没勾 = null(全部可用);勾了 = 白名单
  return checked.length ? checked : null;
}
function renderAgentList() {
  const box = $('agent-list'); box.innerHTML = '';
  if (!agentsCache.length) { box.innerHTML = '<div class="empty-hint" style="padding:8px 0;color:var(--muted)">还没有 Agent。下面建一个，或在对话里说「帮我造一个 XX 的 Agent」。</div>'; return; }
  agentsCache.forEach(a => {
    const card = document.createElement('div'); card.className = 'agent-card';
    const em = document.createElement('div'); em.className = 'ac-emoji'; em.textContent = a.emoji || '🤖';
    const main = document.createElement('div'); main.className = 'ac-main';
    const plugTxt = Array.isArray(a.plugins) ? ('插件:' + (a.plugins.length ? a.plugins.join(', ') : '无')) : '插件:全部';
    main.innerHTML = `<div class="ac-name">${escapeHtml(a.name)}</div><div class="ac-desc">${escapeHtml(a.systemPrompt || '')}</div><div class="ac-meta">${plugTxt}${a.model ? ' · 模型:' + escapeHtml(a.model) : ''}${a.aiGenerated ? ' · AI 生成' : ''}</div>`;
    const acts = document.createElement('div'); acts.className = 'ac-acts';
    const e = document.createElement('button'); e.className = 'btn sm'; e.textContent = '编辑'; e.addEventListener('click', () => fillAgentForm(a));
    const x = document.createElement('button'); x.className = 'btn sm danger'; x.textContent = '删除';
    x.addEventListener('click', async () => { if (confirm('删除 Agent「' + a.name + '」?用到它的对话会恢复默认。')) { agentsCache = await window.agents.remove(a.id); renderAgentList(); populateAgentSelect(); } });
    acts.appendChild(e); acts.appendChild(x);
    card.appendChild(em); card.appendChild(main); card.appendChild(acts);
    box.appendChild(card);
  });
}
function fillAgentForm(a) {
  agf.id.value = a.id; agf.emoji.value = a.emoji || '🤖'; agf.name.value = a.name || ''; agf.sys.value = a.systemPrompt || ''; agf.model.value = a.model || '';
  agf.title.textContent = '编辑 Agent:' + a.name;
  renderPluginChecks(Array.isArray(a.plugins) ? a.plugins : []);
  pages.agents.scrollTop = 0;
}
function resetAgentForm() {
  agf.id.value = ''; agf.emoji.value = ''; agf.name.value = ''; agf.sys.value = ''; agf.model.value = '';
  agf.title.textContent = '新建 Agent'; renderPluginChecks([]);
}
$('ag-reset').addEventListener('click', resetAgentForm);
$('ag-save').addEventListener('click', async () => {
  if (!agf.name.value.trim()) { alert('请填写名称'); return; }
  if (!agf.sys.value.trim()) { alert('请填写系统提示词'); return; }
  agentsCache = await window.agents.save({ id: agf.id.value || undefined, emoji: agf.emoji.value, name: agf.name.value, systemPrompt: agf.sys.value, model: agf.model.value, plugins: readPluginChecks() });
  resetAgentForm(); renderAgentList(); populateAgentSelect();
});
async function refreshAgents() { agentsCache = await window.agents.list(); renderAgentList(); if (!agf.id.value) renderPluginChecks([]); populateAgentSelect(); }

// 顶栏「主角」选择器
const agentSelect = $('agent-select');
function populateAgentSelect() {
  const cur = agentSelect.value;
  agentSelect.innerHTML = '<option value="">无（默认 Claude）</option>';
  agentsCache.forEach(a => { const o = document.createElement('option'); o.value = a.id; o.textContent = (a.emoji || '🤖') + ' ' + a.name; agentSelect.appendChild(o); });
  agentSelect.value = cur;
}
function syncAgentPicker(agentId, kind) {
  $('agent-pick').style.display = (kind === 'plugin' || kind === 'evolve') ? 'none' : '';
  $('evolve-rollback').style.display = (kind === 'evolve') ? '' : 'none';
  agentSelect.value = agentId || '';
}
agentSelect.addEventListener('change', async () => {
  if (!currentConvId) return;
  await window.conv.setAgent(currentConvId, agentSelect.value || null);
  const c = convCache.find(x => x.id === currentConvId); if (c) c.agentId = agentSelect.value || null;
  const a = agentsCache.find(x => x.id === agentSelect.value);
  appendLive({ type: 'system', text: agentSelect.value ? `🤖 本对话主角已设为「${a ? a.name : ''}」(已重载,人设生效)` : '🤖 已取消主角,恢复默认 Claude(已重载)' });
});

// ===================== 团队 / 工作流 =====================
let workflowsCache = [];
let wfDraft = { id: '', name: '', emoji: '', stages: [] };
function agentOptions(selected) {
  let html = '<option value="">（选一个 Agent）</option>';
  agentsCache.forEach(a => { html += `<option value="${a.id}"${a.id === selected ? ' selected' : ''}>${escapeHtml((a.emoji || '🤖') + ' ' + a.name)}</option>`; });
  return html;
}
function renderWfStages() {
  const box = $('wf-stages'); box.innerHTML = '';
  wfDraft.stages.forEach((st, si) => {
    const sd = document.createElement('div'); sd.className = 'wf-stage';
    const head = document.createElement('div'); head.className = 'wf-stage-head';
    head.innerHTML = `<b>阶段 ${si + 1}</b><input type="text" placeholder="阶段名(可选)" value="${escapeHtml(st.name || '')}" data-k="name"/>` +
      `<label class="par"><input type="checkbox" data-k="parallel"${st.parallel ? ' checked' : ''}/>阶段内并行</label>` +
      `<button class="wf-x" title="删除此阶段" data-act="delstage">✕</button>`;
    head.querySelector('[data-k=name]').addEventListener('input', e => { st.name = e.target.value; });
    head.querySelector('[data-k=parallel]').addEventListener('change', e => { st.parallel = e.target.checked; });
    head.querySelector('[data-act=delstage]').addEventListener('click', () => { wfDraft.stages.splice(si, 1); renderWfStages(); });
    sd.appendChild(head);
    (st.tasks || []).forEach((t, ti) => {
      const row = document.createElement('div'); row.className = 'wf-task';
      const sel = document.createElement('select'); sel.innerHTML = agentOptions(t.agentId);
      sel.addEventListener('change', e => { t.agentId = e.target.value; });
      const ta = document.createElement('textarea'); ta.placeholder = '交给它的指令… 可用 {{input}} {{prev}}'; ta.value = t.prompt || '';
      ta.addEventListener('input', e => { t.prompt = e.target.value; });
      const x = document.createElement('button'); x.className = 'wf-x'; x.textContent = '✕'; x.title = '删除任务';
      x.addEventListener('click', () => { st.tasks.splice(ti, 1); renderWfStages(); });
      row.appendChild(sel); row.appendChild(ta); row.appendChild(x); sd.appendChild(row);
    });
    const addT = document.createElement('button'); addT.className = 'btn sm'; addT.textContent = '＋ 加任务';
    addT.addEventListener('click', () => { st.tasks = st.tasks || []; st.tasks.push({ agentId: '', prompt: '' }); renderWfStages(); });
    sd.appendChild(addT);
    box.appendChild(sd);
  });
}
$('wf-add-stage').addEventListener('click', () => { wfDraft.stages.push({ name: '', parallel: false, tasks: [{ agentId: '', prompt: '' }] }); renderWfStages(); });
function resetWfForm() { wfDraft = { id: '', name: '', emoji: '', stages: [] }; $('wf-id').value = ''; $('wf-name').value = ''; $('wf-emoji').value = ''; $('wf-form-title').textContent = '新建工作流'; renderWfStages(); }
function fillWfForm(w) {
  wfDraft = { id: w.id, name: w.name, emoji: w.emoji, stages: JSON.parse(JSON.stringify(w.stages || [])) };
  $('wf-id').value = w.id; $('wf-name').value = w.name || ''; $('wf-emoji').value = w.emoji || '';
  $('wf-form-title').textContent = '编辑工作流:' + w.name; renderWfStages(); pages.workflows.scrollTop = 0;
}
$('wf-reset').addEventListener('click', resetWfForm);
$('wf-save').addEventListener('click', async () => {
  const name = $('wf-name').value.trim(); if (!name) { alert('请填写工作流名称'); return; }
  if (!wfDraft.stages.length) { alert('至少加一个阶段'); return; }
  workflowsCache = await window.workflows.save({ id: $('wf-id').value || undefined, name, emoji: $('wf-emoji').value, stages: wfDraft.stages });
  resetWfForm(); renderWorkflowList();
});
function renderWorkflowList() {
  const box = $('wf-list'); box.innerHTML = '';
  if (!workflowsCache.length) { box.innerHTML = '<div class="empty-hint" style="padding:8px 0;color:var(--muted)">还没有工作流。下面建一个，把几个 Agent 串成流水线。</div>'; return; }
  workflowsCache.forEach(w => {
    const card = document.createElement('div'); card.className = 'wf-card';
    const main = document.createElement('div'); main.className = 'wc-main';
    const steps = (w.stages || []).map((s, i) => `${i + 1}.${s.name || '阶段'}${s.parallel && (s.tasks || []).length > 1 ? '⇉' : ''}(${(s.tasks || []).length})`).join('  →  ');
    main.innerHTML = `<div class="wc-name">${escapeHtml((w.emoji || '🧩') + ' ' + w.name)}</div><div class="wc-meta">${escapeHtml(steps || '(空)')}</div>`;
    const acts = document.createElement('div'); acts.className = 'wc-acts';
    const run = document.createElement('button'); run.className = 'btn sm primary'; run.textContent = '▶ 运行'; run.addEventListener('click', () => runWorkflowFlow(w));
    const e = document.createElement('button'); e.className = 'btn sm'; e.textContent = '编辑'; e.addEventListener('click', () => fillWfForm(w));
    const x = document.createElement('button'); x.className = 'btn sm danger'; x.textContent = '删除';
    x.addEventListener('click', async () => { if (confirm('删除工作流「' + w.name + '」?')) { workflowsCache = await window.workflows.remove(w.id); renderWorkflowList(); } });
    acts.appendChild(run); acts.appendChild(e); acts.appendChild(x);
    card.appendChild(main); card.appendChild(acts); box.appendChild(card);
  });
}
async function refreshWorkflows() { agentsCache = await window.agents.list(); workflowsCache = await window.workflows.list(); renderWorkflowList(); if (!$('wf-id').value && !wfDraft.stages.length) renderWfStages(); }
async function runWorkflowFlow(w) {
  if (looping || wfRunning) { alert('当前有任务在运行,请等它结束。'); return; }
  const input = prompt('给「' + w.name + '」一个输入(会替换任务里的 {{input}}):', '');
  if (input === null) return;
  if (!currentConvId) await newConversation();
  showPage('chat');
  appendLive({ type: 'user', text: '▶ 运行工作流「' + w.name + '」\n输入:' + (input || '(无)') });
  wfRunning = true; busy = true;
  refreshSendUI();
  setBusy('工作流运行中…');
  window.workflows.run(currentConvId, w.id, input);
}

let wfRunning = false;
function appendWfStage(txt) { if (logEl.querySelector('.welcome')) logEl.innerHTML = ''; const w = ensureWrap(); const d = document.createElement('div'); d.className = 'wf-run-stage'; d.innerHTML = '<span>' + escapeHtml(txt) + '</span>'; w.appendChild(d); logEl.scrollTop = logEl.scrollHeight; }
const wfTaskEls = {};
function wfTaskKey(s, t) { return s + '_' + t; }
window.workflows.onEvent((d) => {
  if (d.convId && d.convId !== currentConvId) return;
  switch (d.kind) {
    case 'start': appendWfStage((d.emoji || '🧩') + ' ' + d.name + ' · 共 ' + d.stages + ' 阶段'); break;
    case 'stage': appendWfStage('阶段 ' + (d.index + 1) + '/' + d.total + ':' + d.name + (d.parallel ? ' ⇉ 并行' : '') + ' · ' + d.count + ' 个任务'); setBusy(d.name + ' 进行中…'); break;
    case 'task-start': {
      if (logEl.querySelector('.welcome')) logEl.innerHTML = '';
      hideThinkingInChat(); // 子任务卡片自带"执行中…"状态,撤掉通用思考气泡免得重复
      const w = ensureWrap(); const el = document.createElement('div'); el.className = 'wf-run-task running';
      el.innerHTML = '<div class="wt-h">' + escapeHtml(d.agent) + ' · 执行中…</div>';
      w.appendChild(el); wfTaskEls[wfTaskKey(d.stage, d.task)] = el; logEl.scrollTop = logEl.scrollHeight; break;
    }
    case 'task-done': {
      const el = wfTaskEls[wfTaskKey(d.stage, d.task)];
      if (el) { el.classList.remove('running'); el.innerHTML = '<div class="wt-h">' + escapeHtml(d.agent) + '</div><div class="wt-b">' + escapeHtml(d.text || '') + '</div>'; }
      logEl.scrollTop = logEl.scrollHeight; break;
    }
    case 'done':
      appendWfStage(d.stopped ? '⏹ 工作流已停止' : '🎉 工作流完成');
      wfRunning = false; busy = false; refreshSendUI(); hideState(); break;
    case 'error':
      appendLive({ type: 'system', text: '⚠️ 工作流出错:' + d.text });
      wfRunning = false; busy = false; refreshSendUI(); hideState(); break;
  }
});

// ===================== Skills 列表 =====================
async function refreshSkills() {
  const listEl = $('skills-list');
  listEl.innerHTML = '<div class="empty-hint">扫描中…</div>';
  let data;
  try { data = await window.skills.list(); }
  catch (e) { listEl.innerHTML = '<div class="empty-hint">读取失败:' + escapeHtml(String(e && e.message || e)) + '</div>'; return; }
  $('skills-dir').textContent = data.dir;
  $('skills-count').textContent = data.items.length;
  if (!data.items.length) { listEl.innerHTML = '<div class="empty-hint">还没有 skill。让 Claude 用 <code>/find-skills</code> 帮你装一个,或用 <code>/huashu-nuwa</code> 帮你造一个。</div>'; return; }
  listEl.innerHTML = '';
  for (const it of data.items) {
    const card = document.createElement('div'); card.className = 'agent-card';
    const emoji = document.createElement('div'); emoji.className = 'ac-emoji'; emoji.textContent = '📚';
    const main = document.createElement('div'); main.className = 'ac-main';
    const nm = document.createElement('div'); nm.className = 'ac-name';
    nm.innerHTML = '<code>/' + escapeHtml(it.name) + '</code>' + (it.isLink ? ' <span class="tag">链接</span>' : '') + (it.hasMd ? '' : ' <span class="tag" style="color:var(--danger)">缺 SKILL.md</span>');
    const desc = document.createElement('div'); desc.className = 'ac-desc'; desc.textContent = it.description || '(无描述)';
    const meta = document.createElement('div'); meta.className = 'ac-meta'; meta.textContent = it.source;
    main.appendChild(nm); main.appendChild(desc); main.appendChild(meta);
    const acts = document.createElement('div'); acts.className = 'ac-acts';
    const openBtn = document.createElement('button'); openBtn.className = 'btn sm'; openBtn.textContent = '查看 SKILL.md';
    openBtn.addEventListener('click', () => { if (it.hasMd) window.skills.open(it.skillFile); });
    if (!it.hasMd) openBtn.disabled = true;
    const revealBtn = document.createElement('button'); revealBtn.className = 'btn sm'; revealBtn.textContent = '打开目录';
    revealBtn.addEventListener('click', () => window.skills.reveal(it.skillFile || it.source));
    acts.appendChild(openBtn); acts.appendChild(revealBtn);
    card.appendChild(emoji); card.appendChild(main); card.appendChild(acts);
    listEl.appendChild(card);
  }
}
$('skills-refresh').addEventListener('click', refreshSkills);

// ===================== 终端模式(真 PTY,xterm.js 渲染) =====================
const TERM_SESSION = 'main';
let term = null, termFit = null, termOpened = false, termAlive = false, termDataBound = false;
function setTermStatus(text, kind) {
  $('term-status').textContent = text;
  const dot = $('term-dot'); dot.classList.remove('ok', 'err');
  if (kind === 'ok') dot.classList.add('ok'); else if (kind === 'err') dot.classList.add('err');
}
function showTermBanner(text) {
  const b = $('term-banner');
  if (!text) { b.style.display = 'none'; b.textContent = ''; return; }
  b.style.display = 'block'; b.textContent = text;
}
function ensureTerm() {
  if (term) return;
  // xterm.js 暴露在全局 window.Terminal / window.FitAddon(addon-fit 的 UMD 入口)
  const Terminal = window.Terminal;
  const FitAddon = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;
  if (!Terminal || !FitAddon) { showTermBanner('xterm.js 没加载到(检查 node_modules/@xterm)'); return; }
  term = new Terminal({
    fontFamily: 'Consolas, "JetBrains Mono", "Cascadia Code", Menlo, monospace',
    fontSize: 13, cursorBlink: true, allowProposedApi: true,
    theme: { background: '#1e1e1e', foreground: '#e8e6df', cursor: '#d97757', selectionBackground: '#44403a' },
    scrollback: 5000, windowsMode: true,
  });
  termFit = new FitAddon();
  term.loadAddon(termFit);
  term.open($('term-host'));
  termFit.fit();
  // Ctrl+V / Ctrl+Shift+V 粘贴；Ctrl+Shift+C 复制。Ctrl+C 保留给 PTY 作为中断。
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return true;
    const k = (e.key || '').toLowerCase();
    if (k === 'v') {
      e.preventDefault();
      navigator.clipboard.readText().then((txt) => {
        if (txt && termAlive) window.cli.write(TERM_SESSION, txt);
      }).catch(() => {});
      return false;
    }
    if (e.shiftKey && k === 'c') {
      const sel = term.getSelection();
      if (sel) {
        e.preventDefault();
        navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
    }
    return true;
  });
  // 右键粘贴：和大部分 Windows 终端一致
  $('term-host').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    navigator.clipboard.readText().then((txt) => {
      if (txt && termAlive) window.cli.write(TERM_SESSION, txt);
    }).catch(() => {});
  });
  if (!termDataBound) {
    term.onData((data) => { if (termAlive) window.cli.write(TERM_SESSION, data); });
    termDataBound = true;
  }
  window.addEventListener('resize', () => { if (term && pages.terminal.classList.contains('active')) try { termFit.fit(); if (termAlive) window.cli.resize(TERM_SESSION, term.cols, term.rows); } catch {} });
  window.cli.onData(({ sessionId, data }) => { if (sessionId === TERM_SESSION && term) term.write(data); });
  window.cli.onExit(({ sessionId, exitCode }) => {
    if (sessionId !== TERM_SESSION) return;
    termAlive = false;
    setTermStatus('已退出 (exit ' + exitCode + ')', 'err');
    if (term) term.write('\r\n\x1b[33m[claude 已退出,点"重启"再来一发]\x1b[0m\r\n');
  });
}
async function openTerminalPage() {
  ensureTerm();
  if (!term) return; // xterm 没装上
  // 渲染完一帧再 fit,确保 host 拿到尺寸
  await new Promise(r => requestAnimationFrame(r));
  try { termFit.fit(); } catch {}
  if (termAlive) { term.focus(); return; }
  await startTermSession();
  term.focus();
}
async function startTermSession() {
  setTermStatus('启动中…');
  showTermBanner('');
  const chk = await window.cli.check();
  if (!chk.available) {
    setTermStatus('不可用', 'err');
    showTermBanner('终端不可用:' + (chk.error || '原因未知') + '。要不就在 PATH 里装上 claude,要不就让 node-pty 在 Electron 里能加载(可能需要 electron-rebuild)。');
    return;
  }
  const r = await window.cli.open({ sessionId: TERM_SESSION, cols: term.cols, rows: term.rows });
  if (!r.ok) { setTermStatus('启动失败', 'err'); showTermBanner(r.error || '未知错误'); return; }
  termAlive = true;
  termOpened = true;
  $('term-cwd').style.display = 'inline-block';
  $('term-cwd').textContent = r.cwd;
  setTermStatus(r.reused ? '复用已有会话' : '运行中', 'ok');
}
$('term-restart').addEventListener('click', async () => {
  if (!term) return;
  if (termAlive) { window.cli.close(TERM_SESSION); termAlive = false; await new Promise(r => setTimeout(r, 200)); }
  term.reset();
  await startTermSession();
  term.focus();
});
$('term-stop').addEventListener('click', () => {
  if (!termAlive) return;
  window.cli.close(TERM_SESSION);
  termAlive = false;
  setTermStatus('已关闭', 'err');
});

// ===================== 启动 =====================
(async function init() {
  window.providers.list().then(updateBadge);
  agentsCache = await window.agents.list(); populateAgentSelect();
  convCache = await window.conv.list();
  const firstChat = convCache.find(c => c.kind !== 'plugin');
  if (firstChat) { currentConvId = firstChat.id; renderSidebar(); openConv(currentConvId); }
  else { renderSidebar(); await newConversation(); }
})();
