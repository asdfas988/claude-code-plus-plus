#!/usr/bin/env node
'use strict';
/**
 * GUI 自动化 / Computer Use MCP server(零依赖,手写 stdio JSON-RPC 2.0)
 * 工具:get_screen_size / screenshot / move_mouse / click / double_click /
 *       list_windows / focus_window / type_text / press_key
 * 全部通过 PowerShell(System.Windows.Forms + System.Drawing + user32.dll),无需原生编译。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function log(...a) { process.stderr.write('[gui-mcp] ' + a.join(' ') + '\n'); }

const PSHELL = (() => {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const abs = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(abs) ? abs : 'powershell.exe';
})();

// PowerShell 执行器(sta=true 时用单线程套间,剪贴板/SendKeys 需要)
function runPs(script, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const a = ['-NoProfile', '-NonInteractive'];
    if (opts.sta) a.push('-STA');
    a.push('-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + script);
    const ps = spawn(PSHELL, a, { windowsHide: true });
    let out = '', err = '';
    ps.stdout.on('data', d => out += d.toString());
    ps.stderr.on('data', d => err += d.toString());
    ps.on('error', reject);
    ps.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || ('powershell exit ' + code))));
  });
}
function tmp(ext) { return path.join(os.tmpdir(), 'guimcp_' + Date.now() + '_' + Math.random().toString(36).slice(2) + (ext || '')); }
const psStr = (s) => "'" + String(s).replace(/'/g, "''") + "'"; // 单引号转义

// ---- 工具定义 ----
const TOOLS = [
  { name: 'get_screen_size', description: '获取主屏幕分辨率(像素宽高)。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'screenshot', description: '截取整个主屏幕并返回图片(用于“看见”屏幕、定位元素)。坐标与真实屏幕 1:1。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'move_mouse', description: '把鼠标移动到屏幕绝对坐标 (x,y)(像素,左上角原点)。', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false } },
  { name: 'click', description: '点击。可选 x,y(先移动再点);button 为 left/right,默认 left。', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right'] } }, additionalProperties: false } },
  { name: 'double_click', description: '在 (x,y) 或当前位置双击左键。', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, additionalProperties: false } },
  { name: 'list_windows', description: '列出当前有标题的窗口(进程ID、进程名、窗口标题)。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'focus_window', description: '把某个窗口切到前台。按 pid 或 title(模糊匹配)二选一。', inputSchema: { type: 'object', properties: { pid: { type: 'number' }, title: { type: 'string' } }, additionalProperties: false } },
  { name: 'type_text', description: '在当前焦点处输入文字(经剪贴板粘贴,支持中文)。', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'press_key', description: '发送按键,SendKeys 语法。例:回车"{ENTER}"、全选"^a"、Alt+F4"%{F4}"、Tab"{TAB}"。', inputSchema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'], additionalProperties: false } },
];

async function moveTo(x, y) {
  await runPs(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`);
}
async function doClick(button, dbl) {
  const down = button === 'right' ? '0x08' : '0x02';
  const up = button === 'right' ? '0x10' : '0x04';
  const one = `[M]::mouse_event(${down},0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 25; [M]::mouse_event(${up},0,0,0,[IntPtr]::Zero);`;
  const script = ['Add-Type @"', 'using System;using System.Runtime.InteropServices;',
    'public class M { [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,IntPtr e); }', '"@;',
    one + (dbl ? ' Start-Sleep -Milliseconds 60; ' + one : '')].join('\n');
  await runPs(script);
}

async function callTool(name, args) {
  args = args || {};
  if (name === 'get_screen_size') {
    const r = await runPs('Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($b.Width)x$($b.Height)"');
    return `主屏幕分辨率:${r}`;
  }
  if (name === 'screenshot') {
    const f = tmp('.png');
    const script = ['Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
      '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
      '$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height)',
      '$g=[System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size)',
      `$bmp.Save(${psStr(f)},[System.Drawing.Imaging.ImageFormat]::Png)`,
      '"$($b.Width)x$($b.Height)"'].join('; ');
    const size = await runPs(script);
    const data = fs.readFileSync(f).toString('base64');
    try { fs.unlinkSync(f); } catch {}
    return { content: [{ type: 'text', text: `屏幕截图,分辨率 ${size}(坐标 1:1)` }, { type: 'image', data, mimeType: 'image/png' }] };
  }
  if (name === 'move_mouse') {
    const x = Math.round(Number(args.x)), y = Math.round(Number(args.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x/y 必须是数字');
    await moveTo(x, y); return `已移动鼠标到 (${x}, ${y})。`;
  }
  if (name === 'click') {
    let where = '当前位置';
    if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) { const x = Math.round(args.x), y = Math.round(args.y); await moveTo(x, y); where = `(${x}, ${y})`; }
    const btn = args.button === 'right' ? 'right' : 'left';
    await doClick(btn, false); return `已在${where}${btn === 'right' ? '右' : '左'}键点击。`;
  }
  if (name === 'double_click') {
    let where = '当前位置';
    if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) { const x = Math.round(args.x), y = Math.round(args.y); await moveTo(x, y); where = `(${x}, ${y})`; }
    await doClick('left', true); return `已在${where}双击。`;
  }
  if (name === 'list_windows') {
    const r = await runPs('Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | ForEach-Object { "$($_.Id)`t$($_.ProcessName)`t$($_.MainWindowTitle)" }');
    return r ? '当前窗口(PID  进程  标题):\n' + r : '(没有可见窗口)';
  }
  if (name === 'focus_window') {
    let finder;
    if (args.pid) finder = `$p = Get-Process -Id ${parseInt(args.pid, 10)} -ErrorAction SilentlyContinue`;
    else if (args.title) finder = `$p = Get-Process | Where-Object { $_.MainWindowTitle -like ${psStr('*' + args.title + '*')} } | Select-Object -First 1`;
    else throw new Error('需要 pid 或 title');
    const script = ['Add-Type @"', 'using System;using System.Runtime.InteropServices;',
      'public class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n); }', '"@;',
      finder + ';',
      'if (-not $p) { "NOTFOUND" } else { [W]::ShowWindow($p.MainWindowHandle,9) | Out-Null; [W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; "OK:" + $p.MainWindowTitle }'].join('\n');
    const r = await runPs(script);
    if (r.startsWith('NOTFOUND')) throw new Error('未找到匹配窗口');
    return '已切到前台:' + r.replace(/^OK:/, '');
  }
  if (name === 'type_text') {
    const f = tmp('.txt'); fs.writeFileSync(f, String(args.text || ''), 'utf8');
    const script = ['Add-Type -AssemblyName System.Windows.Forms',
      `$t=[IO.File]::ReadAllText(${psStr(f)},[Text.Encoding]::UTF8)`,
      '[System.Windows.Forms.Clipboard]::SetText($t)',
      'Start-Sleep -Milliseconds 60',
      "[System.Windows.Forms.SendKeys]::SendWait('^v')"].join('; ');
    await runPs(script, { sta: true });
    try { fs.unlinkSync(f); } catch {}
    return `已输入文字(${String(args.text).length} 字)。`;
  }
  if (name === 'press_key') {
    const keys = String(args.keys || '');
    await runPs(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psStr(keys)})`, { sta: true });
    return `已发送按键:${keys}`;
  }
  throw new Error('未知工具: ' + name);
}

// ---- JSON-RPC over stdio ----
function write(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
async function handle(msg) {
  const { id, method, params } = msg; const hasId = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize': write({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'gui-automation', version: '0.2.0' } } }); break;
      case 'notifications/initialized': case 'notifications/cancelled': break;
      case 'ping': write({ jsonrpc: '2.0', id, result: {} }); break;
      case 'tools/list': write({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); break;
      case 'resources/list': write({ jsonrpc: '2.0', id, result: { resources: [] } }); break;
      case 'prompts/list': write({ jsonrpc: '2.0', id, result: { prompts: [] } }); break;
      case 'tools/call': {
        const tname = params && params.name; const targs = (params && params.arguments) || {};
        log('tools/call', tname);
        try {
          const r = await callTool(tname, targs);
          const result = (r && r.content) ? { content: r.content } : { content: [{ type: 'text', text: String(r) }] };
          write({ jsonrpc: '2.0', id, result });
        } catch (e) { write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '错误: ' + e.message }], isError: true } }); }
        break;
      }
      default: if (hasId) write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    }
  } catch (e) { if (hasId) write({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } }); }
}
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString(); let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, idx).trim(); buffer = buffer.slice(idx + 1); if (!line) continue; let msg; try { msg = JSON.parse(line); } catch { continue; } handle(msg); }
});
process.stdin.on('end', () => process.exit(0));
log('server ready');
