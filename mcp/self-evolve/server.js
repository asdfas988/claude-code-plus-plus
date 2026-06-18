#!/usr/bin/env node
'use strict';
/**
 * 内置「自我进化」MCP server(零依赖)
 * 只在「自我进化」对话里启用。让 Claude 安全地改 App 自己的源码:
 * - snapshot:git 快照(自动 init + .gitignore),每次改动前存档,便于回滚
 * - list_snapshots / rollback:查看与回滚
 * - reload:请求主进程软重载界面(renderer)或重启 App(main)
 * env:PROJECT_DIR(App 源码根目录) + AGENT_DATA_DIR(写重载信号文件)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function log(...a) { process.stderr.write('[selfevolve] ' + a.join(' ') + '\n'); }
const PROJECT_DIR = process.env.PROJECT_DIR || '';
const DATA = process.env.AGENT_DATA_DIR || '';
const SIGNAL_FILE = path.join(DATA, '.evolve-signal.json');

// 不用 shell:true:git.exe 经 CreateProcess 直接调,参数按字面传,空格/中文不会被 shell 拆断
function git(args) { const r = spawnSync('git', args, { cwd: PROJECT_DIR, encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; }
function isRepo() { return git(['rev-parse', '--is-inside-work-tree']).out === 'true'; }
function ensureRepo() {
  if (isRepo()) return;
  const gi = path.join(PROJECT_DIR, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, ['node_modules/', '*.log', '*.test.json', 'engine-test*', '.evolve-signal.json'].join('\n') + '\n', 'utf8');
  git(['init']);
  git(['add', '-A']);
  git(['-c', 'user.email=agent@local', '-c', 'user.name=Self Evolve', 'commit', '-m', 'baseline: 自我进化基线']);
}

const TOOLS = [
  { name: 'snapshot', description: '改动源码【之前】先打一个 git 快照存档(便于回滚)。首次会自动 git init。', inputSchema: { type: 'object', properties: { message: { type: 'string', description: '这次改动的简述,如“把发送按钮改成蓝色”' } }, required: ['message'], additionalProperties: false } },
  { name: 'list_snapshots', description: '列出最近的快照(git 提交历史)。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'rollback', description: '回滚到某个快照。to 传提交哈希;或传 "last" 撤销最近一次改动(回到上一个快照)。回滚后会自动请求重载。', inputSchema: { type: 'object', properties: { to: { type: 'string', description: '提交哈希,或 "last"' } }, required: ['to'], additionalProperties: false } },
  { name: 'reload', description: '改完源码后让改动生效。scope="renderer"=软重载界面(改 renderer/ 时用,即时);scope="app"=重启整个 App(改 main.js / preload.js 时用,会让用户确认)。', inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['renderer', 'app'] } }, required: ['scope'], additionalProperties: false } },
];

function signal(action) { try { fs.writeFileSync(SIGNAL_FILE, JSON.stringify({ action, ts: Date.now() }), 'utf8'); } catch (e) { log('signal fail', e.message); } }

async function callTool(name, args) {
  args = args || {};
  if (!PROJECT_DIR) throw new Error('未设置 PROJECT_DIR');

  if (name === 'snapshot') {
    ensureRepo();
    git(['add', '-A']);
    const msg = (args.message || '自我进化改动').slice(0, 120);
    const c = git(['-c', 'user.email=agent@local', '-c', 'user.name=Self Evolve', 'commit', '-m', msg, '--allow-empty']);
    const head = git(['rev-parse', '--short', 'HEAD']).out;
    return `已打快照 [${head}] ${msg}。现在可以安全修改源码,改完调 reload 生效;若不满意可 rollback。`;
  }
  if (name === 'list_snapshots') {
    if (!isRepo()) return '(还没有任何快照,先 snapshot)';
    const r = git(['log', '--oneline', '-n', '15']);
    return r.out || '(无历史)';
  }
  if (name === 'rollback') {
    if (!isRepo()) throw new Error('还没有 git 仓库,无法回滚');
    const target = args.to === 'last' ? 'HEAD~1' : args.to;
    const r = git(['reset', '--hard', target]);
    if (r.code !== 0) throw new Error('回滚失败: ' + (r.err || r.out));
    const head = git(['rev-parse', '--short', 'HEAD']).out;
    signal('reload');
    return `已回滚到 [${head}]。已请求重载界面。若回滚了 main.js 改动,可能需要重启 App。`;
  }
  if (name === 'reload') {
    const scope = args.scope === 'app' ? 'restart' : 'reload';
    signal(scope);
    return scope === 'restart' ? '已请求重启 App(会弹确认),重启后 main.js 改动生效。' : '已请求软重载界面,renderer 改动即时生效。';
  }
  throw new Error('未知工具: ' + name);
}

// ---- JSON-RPC over stdio ----
function write(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
async function handle(m) {
  const { id, method, params } = m; const hasId = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize': write({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'self-evolve', version: '0.1.0' } } }); break;
      case 'notifications/initialized': case 'notifications/cancelled': break;
      case 'ping': write({ jsonrpc: '2.0', id, result: {} }); break;
      case 'tools/list': write({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); break;
      case 'resources/list': write({ jsonrpc: '2.0', id, result: { resources: [] } }); break;
      case 'prompts/list': write({ jsonrpc: '2.0', id, result: { prompts: [] } }); break;
      case 'tools/call': {
        const tn = params && params.name; const ta = (params && params.arguments) || {};
        log('call', tn);
        try { const text = await callTool(tn, ta); write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }); }
        catch (e) { write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '错误: ' + e.message }], isError: true } }); }
        break;
      }
      default: if (hasId) write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    }
  } catch (e) { if (hasId) write({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } }); }
}
let buf = '';
process.stdin.on('data', c => { buf += c.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l); } catch { continue; } handle(m); } });
process.stdin.on('end', () => process.exit(0));
log('ready, project=' + PROJECT_DIR);
