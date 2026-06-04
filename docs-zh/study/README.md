# Google Antigravity SDK 学习手册

欢迎使用 **Google Antigravity SDK** 学习手册。本项目是一个为构建由 Antigravity 和 Gemini 驱动的 AI Agent 提供的 Python SDK。它提供了一个安全、可扩展、有状态的基础设施层，对 AI Agent 的执行循环（Agentic Loop）进行了抽象，使你能够专注于 Agent 应该“做什么”，而无需关心它是“如何运行”的。

本学习手册旨在帮助你快速上手并深入理解 SDK 的核心设计、架构与高级特性。

---

## 📖 目录指南

为了由浅入深地掌握本 SDK，建议按照以下模块顺序进行学习：

1. **[01_快速开始](./01_快速开始.md)**
   - venv 安装、`.env` 配置 API Key
   - 编写 / 运行 Hello World Agent
   - 流式响应处理（Streaming）
   - 只读与写权限的基础控制

2. **[02_核心架构](./02_核心架构.md)**
   - 三层架构设计（Agent、Conversation、Connection）
   - **Local Harness（`localharness`）二进制**：职责、启动握手、协议与工具分工
   - 核心类职责划分与生命周期、消息流转

3. **[03_工具机制](./03_工具机制.md)**
   - 自定义 Python 工具函数注册
   - 使用 `ToolContext` 实现跨 Turn 的工具状态维护
   - 工具访问控制：禁用（CapabilitiesConfig）与拒绝（Policy.deny）的对比

4. **[04_MCP集成](./04_MCP集成.md)**
   - MCP 协议与 McpBridge 核心概念
   - 连接本地/远程 MCP 服务器（Stdio, SSE, Streamable HTTP）
   - MCP 工具自动注册与调用

5. **[05_生命周期拦截与安全策略](./05_生命周期拦截与安全策略.md)**
   - Hook 的三种类型（Inspect、Decide、Transform）
   - 执行顺序与 TOCTOU 安全防御
   - 层次化上下文系统（Session, Turn, Operation Context）
   - 声明式安全策略设计（Deny by Default 姿态、ASK_USER 交互式确认）

6. **[06_背景触发器](./06_背景触发器.md)**
   - Triggers 与 Hooks 的职责对比
   - 周期性定时触发器（every）
   - 文件系统监控触发器（on_file_change）
   - 背景触发器的生命周期与隔离性

7. **[07_高级特性](./07_高级特性.md)**
   - 多模态数据输入（Image、Document、Audio、Video、from_file）
   - 会话持久化与恢复（conversation_id 机制）
   - 子 Agent 机制（Subagents）及其 Hook 传递规则
   - 交互式 CLI 运行循环

8. **[08_权限机制与LLM调用](./08_权限机制与LLM调用.md)**
   - 能力配置（CapabilitiesConfig）与策略（Policies）双层权限模型
   - 默认策略、工作区限制、启动期安全校验与运行时拦截路径
   - Gemini 配置下发、Local Harness 调用链与 `chat()` 端到端流程

9. **[09_项目运行与功能全景](./09_项目运行与功能全景.md)**
   - venv 安装（PEP 668）、`.env` / `.env.example` 配置 API Key
   - Google 账号与团队共用凭证说明（AI Studio / Vertex）
   - `hello_world.py` 验证步骤、功能对照表与常见问题

---

## 📂 代码库核心结构对照

在阅读或修改 SDK 源码时，可以参考以下目录映射：

| 模块/路径 | 核心类 & 职责 | 关联设计文档 |
| :--- | :--- | :--- |
| [google/antigravity/agent.py](../../google/antigravity/agent.py) | `Agent`：高层声明式入口，负责配置、Hooks、Triggers、MCP 桥接的统一管理。 | [README.md](../../google/README.md) |
| [google/antigravity/connections/](../../google/antigravity/connections/) | 适配器层，负责与底层 Go 运行时的通信和二进制进程生命周期管理。 | [Connections README](../../google/antigravity/connections/README.md) |
| [google/antigravity/conversation/](../../google/antigravity/conversation/) | 会话状态层，维护历史步骤 `Step` 积累、上下文压缩、turn 计数等。 | [Conversation README](../../google/antigravity/conversation/README.md) |
| [google/antigravity/hooks/](../../google/antigravity/hooks/) | 拦截器层，提供细粒度的运行时控制拦截及声明式策略库（`policy.py`）。 | [Hooks README](../../google/antigravity/hooks/README.md) |
| [google/antigravity/mcp/](../../google/antigravity/mcp/) | MCP 桥接，利用标准协议动态扩展 Agent 可以调用的工具集。 | [MCP README](../../google/antigravity/mcp/README.md) |
| [google/antigravity/tools/](../../google/antigravity/tools/) | Python 工具运行器，管理本地/自定义的同步与异步 Python 函数。 | [Tools README](../../google/antigravity/tools/README.md) |
| [google/antigravity/triggers/](../../google/antigravity/triggers/) | 背景任务调度，通过外部事件被动唤醒 Agent 发送信息。 | [Triggers README](../../google/antigravity/triggers/README.md) |
| [google/antigravity/types.py](../../google/antigravity/types.py) | 强类型数据模型定义（基于 Pydantic V2），屏蔽 Proto 细节，提供安全的用户边界。 | - |

---

## 💡 核心心智模型

使用此 SDK 的最重要理念是**将声明式配置（什么可以做）与运行时会话状态（做了什么）分离开来**：

```
┌─────────────────────────────────────────────────────────┐
│            Agent  (Layer 1 - 生命周期与配置)            │
│  拥有: 配置(Config)、钩子(Hooks)、策略(Policies)、       │
│        触发器(Triggers)、MCP桥接、Python工具运行器        │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │       Conversation  (Layer 2 - 有状态会话)         │  │
│  │  拥有: 交互历史(History)、回合追踪(Turn Tracking)、 │  │
│  │        上下文压缩(Compaction)、Token统计          │  │
│  │                                                   │  │
│  │  ┌─────────────────────────────────────────────┐ │  │
│  │  │        Connection  (Layer 3 - 传输层)       │ │  │
│  │  │  拥有: WebSockets 协议、二进制进程管理、     │ │  │
│  │  │        空闲/唤醒状态、断开连接控制             │ │  │
│  │  └─────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

- **配置定义在最外层（Agent）**：配置工具、策略、MCP 属于静态声明，规定了 Agent 的能力边界。
- **状态维护在中间层（Conversation）**：聊天历史、回合数、Token 使用统计属于动态状态，在对话中逐步累积。
- **通信屏蔽在最底层（Connection）**：网络通信与进程调用完全被屏蔽，外部用户甚至不需要知道底层存在一个编译好的 Go 运行时。

**想先跑起来？** 可直接阅读 **[09_项目运行与功能全景](./09_项目运行与功能全景.md)**，再按专题深入 01～08。

准备好了吗？现在，请移步 **[01_快速开始](./01_快速开始.md)** 或 **[09_项目运行与功能全景](./09_项目运行与功能全景.md)** 开启你的 Antigravity 探索之旅！
