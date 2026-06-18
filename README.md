# Claude Code++

把命令行的 **Claude Code** 包成一个图形化、像 Codex 一样能直接操作电脑的桌面 App。基于 Electron，驱动本机的 `claude` CLI。

> Powered by Claude。这是一个独立第三方桌面客户端，与 Anthropic 官方产品无关。

## 功能

- **对话式 Agent**：流式回复，驱动本机 Claude Code CLI（常驻进程预热、`--resume` 续接）
- **服务商一键切换**：多套 API 档案（官方登录 / 中转 / 自定义 BaseURL+模型），密钥经系统 `safeStorage` 加密存储
- **Computer Use**：看屏幕截图、列窗口/聚焦、移动鼠标点击、打字（支持中文）—— 内置零依赖 GUI 自动化 MCP
- **浏览器**：Playwright 受控浏览器 / 接管你正在用的 Chrome
- **插件系统**：对话里一句话让 Claude 帮你造插件（自动生成零依赖 MCP server 并注册），或安装现成 MCP
- **自定义 Agent**：人设 + 可用插件 + 模型；可当对话主角，也能被 `run_agent` 召唤为子代理
- **Agent Loop**：worker 做 → 独立 reviewer 审 → 独立 grader 判分，不达成自动迭代，直到达成或到上限
- **团队 / 工作流**：把多个 Agent 编排成流水线，阶段顺序执行、阶段内任务并行，`{{input}}`/`{{prev}}` 变量传递
- **自我进化** 🧬：直接和 App 对话让它**改自己的源码**（加功能 / 改界面 / 调设计），每次改动前自动 git 快照、可一键回滚；界面改动软重载即时生效，主进程改动确认后重启

## 运行（开发态，从源码跑）

需要本机已安装并登录 [Claude Code CLI](https://docs.claude.com/claude-code) 与 [Node.js](https://nodejs.org)、[git](https://git-scm.com)。

```bash
git clone <this-repo-url>
cd claude-code-plus-plus
npm install
npm start
```

## 说明

- 平台：目前面向 Windows。
- 你的对话、插件、Agent、工作流、服务商档案等数据都存在 Electron 的 **userData** 目录（`%APPDATA%/claude-desktop-agent`），**不在本仓库里**，所以仓库不含任何密钥或个人数据。
- 自我进化只在「从源码运行」时可用（打包成 exe 后核心源码会被只读封存）。

## 目录结构

```
main.js                 Electron 主进程:引擎(spawn claude)/IPC/对话·Agent·工作流·插件 存储与逻辑
preload.js              contextBridge 暴露给界面的 API
renderer/index.html     界面结构 + 全部 CSS
renderer/renderer.js    界面交互逻辑
mcp/gui-automation/     内置:看屏幕/鼠标/键盘(PowerShell)
mcp/plugin-manager/     内置:对话里创建/安装/启停插件
mcp/agent-manager/      内置:创建/编辑/召唤自定义 Agent
mcp/self-evolve/        内置:git 快照/回滚/重载,支撑自我进化
```
