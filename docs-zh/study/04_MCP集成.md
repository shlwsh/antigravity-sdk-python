# 04 模型上下文协议 (MCP) 集成

**模型上下文协议 (Model Context Protocol, MCP)** 是一个开放标准，允许 Agent 与外部数据源和工具服务进行标准化对接。通过 MCP，你可以无缝接入社区已经构建好的海量第三方工具（如 SQLite 查询、GitHub 操作、文件搜索等），而无需自己编写复杂的 API 适配代码。

---

## 🌉 `McpBridge` 与工具命名空间

SDK 内置了 `McpBridge`（MCP 桥接器）来简化连接管理：
1. **自动工具发现**：在成功连接 MCP 服务器后，桥接器会自动拉取服务器上声明的所有工具及其 JSON Schema。
2. **命名空间隔离与重命名**：为了防止多个 MCP 服务器之间的工具发生命名冲突，并符合 Gemini API 的命名要求（仅允许字母、数字、下划线及连字符），SDK 会对工具进行**统一的前缀重命名**：

$$
\text{重命名后的工具名} = \text{mcp\_} + \text{服务器配置名称(name)} + \text{\_} + \text{原始工具名}
$$

例如：如果你配置了一个名为 `github_agent` 的 MCP 服务器，它导出了一个原始名为 `create_issue` 的工具，那么该工具在 LLM 端的最终注册名称将是：
`mcp_github_agent_create_issue`

---

## 🛜 支持的服务器连接类型

SDK 提供了三种连接配置类，涵盖了本地和远程连接场景：

### 1. 本地标准输入输出 (`McpStdioServer`)
通过在后台拉起子进程（例如 Node.js, Python, npx 命令）进行通信。这是最常用的本地开发和运行方式。
```python
from google.antigravity.types import McpStdioServer

config_stdio = McpStdioServer(
    name="my_local_server",
    command="npx",
    args=["-y", "@modelcontextprotocol/server-everything"],
    # 支持选择性地启用或禁用该服务器暴露的部分工具（二者互斥）
    # enabled_tools=["tool_a", "tool_b"],
    # disabled_tools=["tool_c"]
)
```

### 2. 远程服务器发送事件 (`McpSseServer`)
通过 SSE 协议连接在远程服务器部署的 MCP 服务。
```python
from google.antigravity.types import McpSseServer

config_sse = McpSseServer(
    name="my_remote_sse",
    url="http://localhost:3001/sse",
    headers={"Authorization": "Bearer some_token"}
)
```

### 3. 可流式传输的 HTTP 连接 (`McpStreamableHttpServer`)
用于更为复杂的远程连接，提供连接超时、SSE 读取超时控制以及连接断开时的保活/关闭策略。
```python
from google.antigravity.types import McpStreamableHttpServer

config_http = McpStreamableHttpServer(
    name="my_streamable_http",
    url="http://remote-mcp-service.internal/tools",
    timeout=30.0,
    sse_read_timeout=300.0,
    terminate_on_close=True
)
```

---

## 💻 MCP 集成完整代码示例

下面演示如何通过 `LocalAgentConfig` 的 `mcp_servers` 选项将一个 stdio 类型的 MCP 服务器连接 to Agent 中。

```python
import asyncio
from google.antigravity import Agent, LocalAgentConfig
from google.antigravity.types import McpStdioServer, CapabilitiesConfig
from google.antigravity.hooks import policy

# 模拟一个审批用户调用的 handler
def confirm_handler(tool_call) -> bool:
    print(f"\n[安全拦截] 拦截到对 MCP 工具的调用: {tool_call.name}")
    print(f"[安全拦截] 参数为: {tool_call.args}")
    # 在交互式 CLI 中，这里可以接收用户的 y/n 输入。这里模拟返回 True（批准）
    return True

async def main() -> None:
    # 1. 定义 stdio 类型的 MCP 服务器
    # 我们连接一个标准测试服务器 `server-everything` 
    everything_server = McpStdioServer(
        name="everything",
        command="npx",
        args=["-y", "@modelcontextprotocol/server-everything"]
    )

    # 2. 开启安全策略
    # 按照安全标准，只要启用了 MCP 服务器，由于其工具可能修改外部环境，
    # 必须显式添加安全策略（policies），否则 SDK 在启动时会引发 ValueError。
    policies = [
        # 默认拒绝一切，以保障安全性
        policy.deny_all(),
        # 针对 dynamic mcp 工具，我们在运行前进行人工审批拦截
        policy.ask_user(
            "mcp_everything_echo", # 重命名后的完整工具名
            handler=confirm_handler
        ),
        # 也可以通过 allow 允许其他无害的 mcp 工具直接通过
        policy.allow("mcp_everything_add")
    ]

    # 3. 组装本地配置
    config = LocalAgentConfig(
        mcp_servers=[everything_server],
        capabilities=CapabilitiesConfig(), # 确保开启全能力
        policies=policies
    )

    # 4. 运行 Agent 会话
    async with Agent(config) as my_agent:
        # 向 Agent 提问，这会促使它调用 mcp_everything_echo 工具
        prompt = "向 everything 服务发送一条消息 'Hello MCP' 并返回结果。"
        print(f"User: {prompt}\n")

        response = await my_agent.chat(prompt)
        print(f"\nAgent: {await response.text()}")

if __name__ == "__main__":
    asyncio.run(main())
```

---

## ⚠️ 安全与 Token 注意事项

- **强制要求 Safety Policy**：当你的 `mcp_servers` 列表不为空时，表明外部接口可能执行写入、破坏或环境读取行为。因此，除非你提供了 `policies` 或在 `HookRunner` 中注册了自定义的 `pre_tool_call_decide_hooks`，否则 SDK 会**拒绝启动**。请始终采用“Deny by Default”Posture。
- **动态清理**：当离开 `async with Agent(config)` 上下文时，`Agent` 会自动调用 `McpBridge.stop()`，清理其所有拉起的子进程及远程 SSE WebSocket 连接，无需担心进程泄漏或连接挂死。
