# 08 权限机制与 LLM 调用

本章说明 Google Antigravity SDK 中**工具权限如何配置与生效**，以及**大语言模型（Gemini）如何被调用**。建议先阅读 [05_生命周期拦截与安全策略](./05_生命周期拦截与安全策略.md) 与 [02_核心架构](./02_核心架构.md)。

---

## 权限机制总览

SDK 将「Agent 能做什么」拆成两层，作用阶段不同，不要混用：

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer A — 能力配置（静态，连接建立前）                          │
│  CapabilitiesConfig / McpServerConfig.enabled|disabled_tools    │
│  → 决定模型上下文中出现哪些工具定义                              │
└────────────────────────────┬────────────────────────────────────┘
                             │ 模型仍可能发起工具调用
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer B — 策略与钩子（动态，每次工具调用时）                    │
│  policies → policy.enforce() → PreToolCallDecideHook            │
│  自定义 PreToolCallDecideHook / ASK_USER 审批                   │
│  → 允许 / 拒绝 / 人工确认，再执行或返回拒绝信息给模型            │
└─────────────────────────────────────────────────────────────────┘
```

| 维度 | 能力配置（禁用） | 策略（拒绝/审批） |
| :--- | :--- | :--- |
| 配置入口 | `LocalAgentConfig.capabilities`、`mcp_servers[].enabled_tools` | `LocalAgentConfig.policies`、`hooks` |
| 模型是否看到工具 | 否（从上下文移除） | 是（可见但可能被拦） |
| Token 成本 | 更低 | 拒绝/重试会消耗 token |
| 典型用途 | 只读 Agent、不需要 shell | 条件拦截、`rm` 阻断、人工 y/n |

---

## Layer A：能力配置（CapabilitiesConfig）

定义在 `google/antigravity/types.py` 的 `CapabilitiesConfig`，通过 `LocalAgentConfig.capabilities` 传入，最终在 `LocalConnectionStrategy._build_harness_config()` 中转为 `HarnessSideTools` 各子项的 `enabled` 标志。

### 内置工具开关

- `enabled_tools`：白名单，与 `disabled_tools` **互斥**（校验器强制）。
- `disabled_tools`：黑名单。
- 二者均为 `None` 时：Harness 默认启用**全部**内置工具。
- `enable_subagents`：为 `True` 且 `START_SUBAGENT` 在活跃工具集中时，子 Agent 才启用。

只读工具集合由 `BuiltinTools.read_only()` 提供（如 `list_dir`、`view_file`、`find_file` 等）；写操作类工具包括 `edit_file`、`create_file`、`run_command` 等。

```python
from google.antigravity import LocalAgentConfig
from google.antigravity.types import CapabilitiesConfig, BuiltinTools

# 仅暴露只读工具 — 写工具不会进入模型上下文
config = LocalAgentConfig(
    capabilities=CapabilitiesConfig(
        enabled_tools=BuiltinTools.read_only(),
    ),
)
```

### MCP 工具开关

每个 `McpStdioServer` / `McpSseServer` / `McpStreamableHttpServer` 可单独设置 `enabled_tools` 或 `disabled_tools`。`McpBridge` 在连接时通过 `_is_tool_allowed()` 过滤，未允许的工具不会注册到 `ToolRunner`，模型同样看不到。

### 其它能力字段

- `compaction_threshold`：上下文压缩 token 阈值（`0` 表示用 Harness 默认，约 50000）。
- `image_model`：图像生成所用模型名（默认 `gemini-3.1-flash-image-preview`）。
- `finish_tool_schema_json`：结构化输出时 `finish` 工具的 JSON Schema。

---

## Layer B：声明式策略（Policies）

策略实现在 `google/antigravity/hooks/policy.py`，在 `Agent.__aenter__` 中通过 `policy.enforce(policies, mcp_servers=...)` 注册为 `PreToolCallDecideHook`。

### 默认策略（LocalAgentConfig）

`LocalAgentConfig` 默认 `policies=policy.confirm_run_command()`：

- **拒绝** `run_command`（模型仍可见该工具，调用会被拒并收到说明）。
- **放行** 其它内置工具。

若需完全自主执行（含 shell），需显式：

```python
from google.antigravity.hooks import policy

config = LocalAgentConfig(policies=[policy.allow_all()])
```

### 工作区自动策略

当 `workspaces` 非空（默认 `[os.getcwd()]`）时，`_apply_workspace_policies` 会在用户策略**之前** prepend `policy.workspace_only(...)`，将 `view_file` / `create_file` / `edit_file` 限制在配置目录（并自动包含 `app_data_dir`）。要取消文件路径限制需设 `workspaces=[]`。

### 决策类型与优先级

三种决策：`APPROVE`、`DENY`、`ASK_USER`（需 `handler`）。

评估顺序（高 → 低，桶内**先匹配先短路**）：

1. 特定工具 DENY  
2. 特定工具 ASK_USER  
3. 特定工具 APPROVE  
4. MCP 前缀 `server/*` DENY / ASK / APPROVE  
5. 全局 `*` DENY / ASK / APPROVE  

MCP 工具在运行时的名为 `mcp_{server}_{tool}`，策略中写 `policy.deny(server_cfg)` 或 `policy.deny(server_cfg, ["tool1"])` 会展开为 `server/*` 或 `server/tool` 形式；`enforce()` 必须传入 `mcp_servers`，否则会 `ValueError`（防止静默绕过）。

常用构建函数：`allow`、`deny`、`ask_user`、`allow_all`、`deny_all`、`safe_defaults`、`workspace_only`。

谓词 `when` 可接收 `args` 字典、完整 `ToolCall`，或 Pydantic 参数模型；评估异常时 **fail-closed**（拒绝调用）。

### 启动期安全校验

`Agent.__aenter__` 在启用**写工具**或 **MCP** 且**无任何** `policies` 与 **无** `PreToolCallDecideHook` 时抛出 `ValueError`，强制显式选择安全姿态。只读内置工具 + 无 MCP 可不带策略启动。

---

## 运行时：策略如何接到每一次工具调用

权限在 Python 侧通过 `HookRunner.dispatch_pre_tool_call()` 生效，有两条路径，都可能在拒绝后把错误信息回传给 Harness（进而进入模型上下文）。

### 路径 1：内置工具（Harness 侧执行）

Go Harness 执行 `list_dir`、`run_command` 等前会发 `ToolConfirmation` 请求。`LocalConnection._handle_tool_confirmation_request()` 构造 `types.ToolCall`，调用 `dispatch_pre_tool_call`；`allow=False` 时发送 `accepted=False`，步骤进入 `STATE_ERROR`，模型可见拒绝结果。

### 路径 2：Python / MCP 工具（SDK 侧执行）

Harness 通过 WebSocket 下发 `ToolCall` 事件。`LocalConnection._handle_tool_call()` 同样先走 `dispatch_pre_tool_call`；拒绝则 `send_tool_results` 返回 `error`，不执行 `ToolRunner`。

允许时：

- `ToolRunner.process_tool_calls()` 执行函数或 MCP；
- 成功 → `PostToolCallHook`；
- 失败 → `OnToolErrorHook`（可转换错误为模型可读结果）。

### 交互式 CLI 的策略升级

`run_interactive_loop()` 会调用 `_upgrade_to_interactive_confirmation()`：将默认的 `deny(run_command)` 换成 `ask_user(run_command, handler=ask_user_handler)`，终端 y/n 确认而非硬拒绝。

---

## 自定义 Hook 与策略的关系

| 机制 | 类型 | 作用 |
| :--- | :--- | :--- |
| `policy.enforce(...)` | `PreToolCallDecideHook` | 声明式规则批量编译 |
| `@hooks.pre_tool_call` 等 | 各类 Hook | 细粒度自定义（见 05 章） |
| `ToolConfirmationHook` | `PreToolCallDecideHook` | 通用 y/n（interactive 工具） |

`PreTurnHook` 可在回合级拒绝整轮对话（与工具权限独立）。`OnInteractionHook` 处理 `ask_question` 等人机交互，不替代工具策略。

---

## LLM 调用：架构与职责边界

**Python SDK 不直接调用 Gemini HTTP API。** 推理与 Agentic 循环在 **Local Harness（Go 二进制）** 内完成；Python 负责配置下发、WebSocket 事件收发、工具执行与 Hook 拦截。

```
用户代码: agent.chat(prompt)
    → Conversation.send() → LocalConnection.send(InputEvent)
        → [Harness] 调用 Gemini API（多轮 tool loop）
        ← StepUpdate（文本 / 工具确认 / ToolCall / FINISH）
    → Conversation 累积 Step / ChatResponse 流式输出
```

---

## LLM 相关配置

### GeminiConfig 与简写

`LocalAgentConfig` 聚合模型相关配置：

| 字段 | 说明 |
| :--- | :--- |
| `gemini_config` | 完整 `GeminiConfig` 对象 |
| `model` | 简写，写入 `gemini_config.models.default.name` |
| `api_key` | 简写，写入 `gemini_config.api_key` |
| `vertex` / `project` / `location` | Vertex AI 后端 |

`GeminiConfig`（`types.py`）主要字段：

- `api_key`：共享密钥；未设则回退环境变量 `GEMINI_API_KEY`。
- `vertex`：`True` 时使用 Vertex AI。
- `models.default`：主推理模型，默认 **`gemini-3.5-flash`**。
- `models.image_generation`：图像生成，默认 **`gemini-3.1-flash-image-preview`**。
- `ModelEntry.generation.thinking_level`：`minimal` / `low` / `medium` / `high`（支持思考的模型）。

```python
from google.antigravity import LocalAgentConfig
from google.antigravity import types

config = LocalAgentConfig(
    model="gemini-3.5-flash",
    api_key="your-key",  # 或 export GEMINI_API_KEY=...
    gemini_config=types.GeminiConfig(
        models=types.ModelConfig(
            default=types.ModelEntry(
                name="gemini-3.5-flash",
                generation=types.GenerationConfig(
                    thinking_level=types.ThinkingLevel.HIGH,
                ),
            ),
        ),
    ),
)
```

### 配置如何进入 Harness

`LocalConnectionStrategy.__aenter__` 流程概要：

1. **校验密钥**：非 Vertex 时必须存在 `api_key` 或 `GEMINI_API_KEY`；Vertex 需 `project`+`location` 或 Express 模式 API key。
2. **启动子进程**：打包的 `localharness` 二进制，stdin 写入 `InputConfig`（含存储目录、客户端版本）。
3. **读取 `OutputConfig`**：获得 WebSocket 端口与 `api_key`（用于 WS 头 `x-goog-api-key`）。
4. **连接 WebSocket**，发送 `InitializeConversationEvent`，内含 `HarnessConfig`：
   - `gemini_config`：`model_name`、`api_key`、`thinking_level`、`use_vertex`、`project`、`location`
   - `system_instructions`、`workspaces`、`tools`（Python/MCP 工具 schema）
   - `harness_side_tools`：各内置工具 enable 标志与 `image_model`
   - `cascade_id`（会话恢复）、`compaction_threshold` 等

此后所有 LLM 往返由 Harness 内部驱动；Python 仅消费 `OutputEvent` / `StepUpdate`。

---

## 一次 chat 的端到端流程

1. **`async with Agent(config)`**  
   注册 Hooks、编译 Policies、连接 MCP、创建 `ToolRunner` 与 `LocalConnectionStrategy`。

2. **`await agent.chat(prompt)`**  
   - `Conversation.send`：若连接忙则 drain 或 `wait_for_idle`；记录 turn 起点；`PreTurnHook`；发送 `InputEvent`（字符串或 `Content` 多模态）。
   - Harness 调用 Gemini，流式产生步骤。
   - `receive_steps` / `receive_chunks`：映射为 `types.Step`（`SOURCE_MODEL` 文本、`TOOL_CALL`、压缩点等）。
   - 工具循环：确认/执行 → `ToolResult` 回传 → Harness 继续推理直至 `FINISH` 或终端错误。

3. **`ChatResponse`**  
   支持 `await response.text()` 或异步迭代 chunk；`usage_metadata` 在 Step 上累计。

会话 ID：`connection.conversation_id`（来自 Harness `cascade_id`），可通过 `LocalAgentConfig(conversation_id=...)` 恢复。

---

## 配置对照速查

| 目标 | 推荐配置 |
| :--- | :--- |
| 只读研究 Agent | `enabled_tools=BuiltinTools.read_only()`，默认 policy 即可 |
| 禁止 shell | 默认 `confirm_run_command()`（已 deny `run_command`） |
| 允许 shell 无确认 | `policies=[policy.allow_all()]` |
| 默认拒绝，白名单放行 | `policies=[policy.deny_all(), policy.allow("list_dir"), ...]` |
| 危险命令参数拦截 | `policy.deny("run_command", when=lambda a: "rm" in a.get("CommandLine",""))` |
| 命令需人工批准 | `policy.ask_user("run_command", handler=my_fn)` |
| 文件仅限项目目录 | 保持默认 `workspaces` 或显式列表 |
| 换模型 / 思考级别 | `model=` 或 `gemini_config.models.default` + `GenerationConfig` |
| Vertex AI | `vertex=True`, `project`, `location` |

---

## 源码索引

| 主题 | 路径 |
| :--- | :--- |
| 能力配置模型 | `google/antigravity/types.py` — `CapabilitiesConfig`, `GeminiConfig` |
| 本地 Agent 默认策略与工作区 | `google/antigravity/connections/local/local_connection_config.py` |
| 策略引擎 | `google/antigravity/hooks/policy.py` |
| Agent 启动与 policy 注册 | `google/antigravity/agent.py` |
| Harness 配置与进程/WebSocket | `google/antigravity/connections/local/local_connection.py` — `LocalConnectionStrategy` |
| 工具确认与 ToolCall 执行 | 同上 — `_handle_tool_confirmation_request`, `_handle_tool_call` |
| 会话 send/chat | `google/antigravity/conversation/conversation.py` |
| 交互式审批升级 | `google/antigravity/utils/interactive.py` |

---

## 与相邻章节的关系

- 工具注册与 `ToolRunner`：[03_工具机制](./03_工具机制.md)  
- MCP 连接与命名：[04_MCP集成](./04_MCP集成.md)  
- Hook 分类与上下文：[05_生命周期拦截与安全策略](./05_生命周期拦截与安全策略.md)  
- 三层架构与 WebSocket 示意：[02_核心架构](./02_核心架构.md)  
- 环境变量与首个示例：[01_快速开始](./01_快速开始.md)
