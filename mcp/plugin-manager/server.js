#!/usr/bin/env node
'use strict';
/**
 * 内置「插件管理器」MCP server(零依赖)
 * 让 Claude 在对话里创建/安装/启停插件。直接读写 App 的 mcp.json 与 plugins 目录。
 * 数据目录由环境变量 AGENT_DATA_DIR 指定(Electron 主进程注入)。
 */
const fs = require('fs');
const path = require('path');

function log(...a) { process.stderr.write('[pluginmgr] ' + a.join(' ') + '\n'); }
const DATA = process.env.AGENT_DATA_DIR || '';
const MCP_FILE = path.join(DATA, 'mcp.json');
const PLUGINS_DIR = path.join(DATA, 'plugins');

function readStore() { try { const s = JSON.parse(fs.readFileSync(MCP_FILE, 'utf8')); if (!Array.isArray(s.servers)) s.servers = []; return s; } catch { return { servers: [] }; } }
function writeStore(s) { fs.writeFileSync(MCP_FILE, JSON.stringify(s, null, 2), 'utf8'); }
function genId() { return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function findServer(store, key) {
  key = String(key || '').trim().toLowerCase();
  return store.servers.find(s => s.id.toLowerCase() === key || (s.name || '').toLowerCase() === key);
}

const TOOLS = [
  {
    name: 'create_plugin',
    description: '创建一个自制插件:把一段完整的零依赖 Node.js stdio MCP server 源码保存并注册启用。当用户要求“做/写/创建一个插件或新工具”时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '插件的简短名称(中文即可)' },
        description: { type: 'string', description: '一句话说明插件能做什么' },
        code: { type: 'string', description: '完整的 Node.js MCP server 源码(零依赖,JSON-RPC over stdio)' },
      },
      required: ['name', 'code'], additionalProperties: false,
    },
  },
  {
    name: 'add_mcp_server',
    description: '注册一个现成的 MCP 服务器(本地命令 stdio 或远程 http)。当用户要求“安装/添加某个已有的 MCP”(如 Playwright)时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        transport: { type: 'string', enum: ['stdio', 'http'] },
        command: { type: 'string', description: 'stdio 时的命令,如 npx' },
        args: { type: 'string', description: 'stdio 时的参数(空格分隔)' },
        url: { type: 'string', description: 'http 时的 URL' },
      },
      required: ['name', 'transport'], additionalProperties: false,
    },
  },
  { name: 'list_plugins', description: '列出当前所有插件及其启用状态。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'set_plugin', description: '启用或禁用一个插件(按名称或 id)。', inputSchema: { type: 'object', properties: { name: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['name', 'enabled'], additionalProperties: false } },
  { name: 'delete_plugin', description: '删除一个插件(按名称或 id,内置插件不可删)。', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } },
];

async function callTool(name, args) {
  args = args || {};
  if (!DATA) throw new Error('未设置 AGENT_DATA_DIR');
  const store = readStore();

  if (name === 'create_plugin') {
    if (!args.code || !args.code.trim()) throw new Error('code 不能为空');
    const id = genId();
    const dir = path.join(PLUGINS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const serverPath = path.join(dir, 'server.js');
    fs.writeFileSync(serverPath, args.code, 'utf8');
    store.servers.push({ id, name: args.name || '新插件', desc: (args.description || '').slice(0, 80), enabled: true, transport: 'stdio', command: 'node', args: [serverPath], builtin: false, aiGenerated: true });
    writeStore(store);
    return `已创建并启用插件「${args.name || '新插件'}」。系统会自动重载,你可以在本对话继续直接使用它。`;
  }
  if (name === 'add_mcp_server') {
    const id = genId();
    const entry = { id, name: args.name || '新插件', desc: (args.description || '').slice(0, 80), enabled: true, builtin: false, transport: args.transport === 'http' ? 'http' : 'stdio' };
    if (entry.transport === 'http') { if (!args.url) throw new Error('http 需要 url'); entry.url = args.url; }
    else { if (!args.command) throw new Error('stdio 需要 command'); entry.command = args.command; entry.args = (args.args || '').trim() ? args.args.trim().split(/\s+/) : []; }
    store.servers.push(entry); writeStore(store);
    return `已注册并启用 MCP「${entry.name}」。系统会自动重载后生效。`;
  }
  if (name === 'list_plugins') {
    const lines = store.servers.map(s => `- ${s.name}${s.builtin ? '(内置)' : ''}: ${s.enabled ? '已启用' : '已禁用'}`);
    return lines.length ? lines.join('\n') : '(暂无插件)';
  }
  if (name === 'set_plugin') {
    const s = findServer(store, args.name); if (!s) throw new Error('未找到插件: ' + args.name);
    s.enabled = !!args.enabled; writeStore(store);
    return `插件「${s.name}」已${s.enabled ? '启用' : '禁用'}。`;
  }
  if (name === 'delete_plugin') {
    const s = findServer(store, args.name); if (!s) throw new Error('未找到插件: ' + args.name);
    if (s.builtin) throw new Error('内置插件不可删除');
    store.servers = store.servers.filter(x => x.id !== s.id); writeStore(store);
    return `插件「${s.name}」已删除。`;
  }
  throw new Error('未知工具: ' + name);
}

// ---- JSON-RPC over stdio ----
function write(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
async function handle(m) {
  const { id, method, params } = m; const hasId = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize': write({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'plugin-manager', version: '0.1.0' } } }); break;
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
