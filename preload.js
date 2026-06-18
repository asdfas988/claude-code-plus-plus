'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  run: (conversationId, prompt) => ipcRenderer.send('run-prompt', { conversationId, prompt }),
  open: (conversationId) => ipcRenderer.send('engine-open', conversationId), // 预热
  loopRun: (convId, goal, maxIter, withReviewer) => ipcRenderer.send('loop:run', { convId, goal, maxIter, withReviewer }),
  loopStop: () => ipcRenderer.send('loop:stop'),
  onEvent: (cb) => ipcRenderer.on('engine-event', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('engine-done', (_e, d) => cb(d)),
  onStatus: (cb) => ipcRenderer.on('engine-status', (_e, d) => cb(d)),
  onLoop: (cb) => ipcRenderer.on('loop-event', (_e, d) => cb(d)),
});

contextBridge.exposeInMainWorld('conv', {
  list: () => ipcRenderer.invoke('conv:list'),
  get: (id) => ipcRenderer.invoke('conv:get', id),
  create: (kind, agentId) => ipcRenderer.invoke('conv:create', agentId ? { kind, agentId } : kind),
  forPlugin: (pluginId, name) => ipcRenderer.invoke('conv:forPlugin', { pluginId, name }),
  setAgent: (convId, agentId) => ipcRenderer.invoke('conv:setAgent', { convId, agentId }),
  remove: (id) => ipcRenderer.invoke('conv:delete', id),
});

contextBridge.exposeInMainWorld('evolve', {
  rollback: () => ipcRenderer.invoke('evolve:rollback'),
});

contextBridge.exposeInMainWorld('agents', {
  list: () => ipcRenderer.invoke('agents:list'),
  save: (p) => ipcRenderer.invoke('agents:save', p),
  remove: (id) => ipcRenderer.invoke('agents:remove', id),
});

contextBridge.exposeInMainWorld('workflows', {
  list: () => ipcRenderer.invoke('workflows:list'),
  save: (p) => ipcRenderer.invoke('workflows:save', p),
  remove: (id) => ipcRenderer.invoke('workflows:remove', id),
  run: (convId, id, input) => ipcRenderer.send('workflow:run', { convId, id, input }),
  stop: () => ipcRenderer.send('workflow:stop'),
  onEvent: (cb) => ipcRenderer.on('workflow-event', (_e, d) => cb(d)),
});

contextBridge.exposeInMainWorld('providers', {
  list: () => ipcRenderer.invoke('providers:list'),
  save: (p) => ipcRenderer.invoke('providers:save', p),
  remove: (id) => ipcRenderer.invoke('providers:remove', id),
  setActive: (id) => ipcRenderer.invoke('providers:setActive', id),
});

contextBridge.exposeInMainWorld('skills', {
  list: () => ipcRenderer.invoke('skills:list'),
  reveal: (p) => ipcRenderer.invoke('skills:reveal', p),
  open: (p) => ipcRenderer.invoke('skills:open', p),
});

contextBridge.exposeInMainWorld('cli', {
  check: () => ipcRenderer.invoke('cli:check'),
  open: (opts) => ipcRenderer.invoke('cli:open', opts || {}),
  write: (sessionId, data) => ipcRenderer.send('cli:write', { sessionId, data }),
  resize: (sessionId, cols, rows) => ipcRenderer.send('cli:resize', { sessionId, cols, rows }),
  close: (sessionId) => ipcRenderer.send('cli:close', { sessionId }),
  onData: (cb) => ipcRenderer.on('cli:data', (_e, d) => cb(d)),
  onExit: (cb) => ipcRenderer.on('cli:exit', (_e, d) => cb(d)),
});

contextBridge.exposeInMainWorld('mcp', {
  list: () => ipcRenderer.invoke('mcp:list'),
  toggle: (id, enabled) => ipcRenderer.invoke('mcp:toggle', { id, enabled }),
  remove: (id) => ipcRenderer.invoke('mcp:remove', id),
  onUpdated: (cb) => ipcRenderer.on('mcp-updated', (_e, d) => cb(d)),
});
