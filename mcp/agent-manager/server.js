#!/usr/bin/env node
'use strict';
/**
 * 内置「Agent 管理器」MCP server(零依赖)
 * 让 Claude 在对话里创建/编辑/删除「自定义 Agent」,以及【召唤】某个 Agent 去做子任务。
 * - Agent = 名称 + 系统提示词(人设/职责) + 可用插件 + 模型。存到 App 的 agents.json。
 * - run_agent:用该 Agent 的系统提示词另起一个全新上下文的 claude 子进程跑一个任务,返回结果(子代理)。
 * 数据目录由环境变量 AGENT_DATA_DIR 指定(Electron 主进程注入)。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function log(...a) { process.stderr.write('[agentmgr] ' + a.join(' ') + '\n'); }
const DATA = process.env.AGENT_DATA_DIR || '';
const AGENTS_FILE = path.join(DATA, 'agents.json');

function readStore() { try { const s = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')); if (!Array.isArray(s.agents)) s.agents = []; return s; } catch { return { agents: [] }; } }
function writeStore(s) { fs.writeFileSync(AGENTS_FILE, JSON.stringify(s, null, 2), 'utf8'); }
function genId() { return 'agent_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function findAgent(store, key) {
  key = String(key || '').trim().toLowerCase();
  return store.agents.find(a => a.id.toLowerCase() === key || (a.name || '').toLowerCase() === key);
}
function parsePlugins(p) {
  if (Array.isArray(p)) return p.map(x => String(x).trim()).filter(Boolean);
  if (typeof p === 'string') return p.trim() ? p.split(/[,\s]+/).map(x => x.trim()).filter(Boolean) : [];
  return null; // null = 全部可用
}

const TOOLS = [
  {
    name: 'create_agent',
    description: '创建一个自定义 Agent(专家角色/子代理):保存它的系统提示词、可用插件、模型。当用户要求“做/造/创建一个 XX 的 agent / 角色 / 助手 / 专家”时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent 的简短名称(中文即可),如“SEO 写手”' },
        emoji: { type: 'string', description: '一个 emoji 作头像(可选)' },
        systemPrompt: { type: 'string', description: '这个 Agent 的系统提示词:它是谁、负责什么、风格与输出要求(尽量具体)' },
        plugins: { type: 'string', description: '该 Agent 允许使用的插件 id,逗号分隔(可选;留空=全部可用)' },
        model: { type: 'string', description: '模型覆盖(可选,如 sonnet;留空=默认)' },
      },
      required: ['name', 'systemPrompt'], additionalProperties: false,
    },
  },
  {
    name: 'update_agent',
    description: '修改一个已有 Agent(按名称或 id)。只传需要改的字段。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要修改的 Agent 名称或 id' },
        newName: { type: 'string' }, emoji: { type: 'string' }, systemPrompt: { type: 'string' }, plugins: { type: 'string' }, model: { type: 'string' },
      },
      required: ['name'], additionalProperties: false,
    },
  },
  { name: 'list_agents', description: '列出当前所有自定义 Agent。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'delete_agent', description: '删除一个 Agent(按名称或 id)。', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } },
  {
    name: 'run_agent',
    description: '【召唤子代理】用某个已存在的 Agent(按名称或 id)的人设,在全新上下文里执行一个具体子任务,并返回它的结果。当你想把一段工作委托给某个专家角色时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: '要召唤的 Agent 名称或 id' },
        task: { type: 'string', description: '交给它的具体任务/输入' },
      },
      required: ['agent', 'task'], additionalProperties: false,
    },
  },
];

// 用指定系统提示词跑一个一次性 claude 子进程,返回最终文本
function runOneShotClaude(systemPrompt, model, task) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--append-system-prompt', systemPrompt];
    if (model) { args.push('--model', model); }
    let out = ''; let child;
    try { child = spawn('claude', args, { shell: true, env: process.env }); }
    catch (e) { resolve('召唤失败: ' + e.message); return; }
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', e => resolve('召唤失败: ' + e.message));
    child.on('close', () => { let text = ''; try { const j = JSON.parse(out); text = j.result || ''; } catch { text = out; } resolve(String(text || '(子代理无输出)')); });
    try { child.stdin.write(task); child.stdin.end(); } catch (e) { resolve('召唤失败: ' + e.message); }
  });
}

async function callTool(name, args) {
  args = args || {};
  if (!DATA) throw new Error('未设置 AGENT_DATA_DIR');
  const store = readStore();

  if (name === 'create_agent') {
    if (!args.systemPrompt || !args.systemPrompt.trim()) throw new Error('systemPrompt 不能为空');
    const id = genId();
    store.agents.push({
      id, name: args.name || '新 Agent', emoji: (args.emoji || '🤖').slice(0, 4),
      systemPrompt: args.systemPrompt, plugins: parsePlugins(args.plugins), model: (args.model || '').trim(),
      builtin: false, aiGenerated: true,
    });
    writeStore(store);
    return `已创建 Agent「${args.name || '新 Agent'}」。你现在可以:在新对话里把它选为主角,或用 run_agent 召唤它做子任务。`;
  }
  if (name === 'update_agent') {
    const a = findAgent(store, args.name); if (!a) throw new Error('未找到 Agent: ' + args.name);
    if (a.builtin) throw new Error('内置 Agent 不可修改');
    if (args.newName) a.name = args.newName;
    if (args.emoji) a.emoji = args.emoji.slice(0, 4);
    if (args.systemPrompt) a.systemPrompt = args.systemPrompt;
    if (args.plugins !== undefined) a.plugins = parsePlugins(args.plugins);
    if (args.model !== undefined) a.model = (args.model || '').trim();
    writeStore(store);
    return `Agent「${a.name}」已更新。`;
  }
  if (name === 'list_agents') {
    const lines = store.agents.map(a => `- ${a.emoji || '🤖'} ${a.name}${a.builtin ? '(内置)' : ''}: ${(a.systemPrompt || '').slice(0, 50)}…`);
    return lines.length ? lines.join('\n') : '(暂无自定义 Agent)';
  }
  if (name === 'delete_agent') {
    const a = findAgent(store, args.name); if (!a) throw new Error('未找到 Agent: ' + args.name);
    if (a.builtin) throw new Error('内置 Agent 不可删除');
    store.agents = store.agents.filter(x => x.id !== a.id); writeStore(store);
    return `Agent「${a.name}」已删除。`;
  }
  if (name === 'run_agent') {
    const a = findAgent(store, args.agent); if (!a) throw new Error('未找到 Agent: ' + args.agent);
    if (!args.task || !args.task.trim()) throw new Error('task 不能为空');
    log('summon', a.name);
    const result = await runOneShotClaude(a.systemPrompt, a.model, args.task);
    return `【${a.emoji || '🤖'} ${a.name} 的执行结果】\n${result}`;
  }
  throw new Error('未知工具: ' + name);
}

// ---- JSON-RPC over stdio ----
function write(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
async function handle(m) {
  const { id, method, params } = m; const hasId = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize': write({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agent-manager', version: '0.1.0' } } }); break;
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
log('ready, data=' + DATA);
