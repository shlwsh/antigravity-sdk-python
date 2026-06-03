---
description: 自动总结文档与代码变更并提交到远程仓库
---

# Git 自动提交工作流 (google-antigravity)

这个工作流会自动完成以下操作:

1. 检测 Git 仓库的所有变更（Python 代码、Markdown 提纲、PDF、脚本等）
2. 使用 AI 分析变更并生成提交信息（未配置 API Key 时按规则生成中文说明）
3. 提交到本地仓库
4. 推送到远程仓库

## 使用方法

```bash
bun run mygit
```

在 Cursor 中也可通过工作流 `/mygit` 触发（需已配置 `.agents/workflows`）。

## 工作流程

1. **检查 Git 仓库** — 确认当前目录是 Git 仓库
2. **检测变更** — 获取所有修改、新增、删除的文件
3. **添加到暂存区** — 执行 `git add -A`，自动排除 `logs/`；`.env` 相关文件会强制纳入提交
4. **生成提交信息** — 优先使用 LLM；若未配置 `DASHSCOPE_API_KEY` 或 AI 调用失败，则按文件变更规则自动生成中文提交信息
5. **提交** — 执行 `git commit`
6. **推送** — 执行 `git push`

## 环境变量（可选，用于 AI 提交说明）

在项目根目录创建 `.env` 或 `.env.local`：

```env
DASHSCOPE_API_KEY=sk-xxx
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen-plus
```

也可使用 `OPENAI_API_KEY` / `OPENAI_API_BASE` / `OPENAI_API_MODEL`。

## 注意事项

- 确保已配置 Git 用户信息（`git config user.name` 和 `git config user.email`）
- 确保有远程仓库的推送权限
- 提交信息使用中文，并遵循常见提交规范（`docs(sdk): ...` 等）
- 未配置 API Key 时仍可通过规则回退正常提交
- 推送到 `*.winning.com.cn` 内网远程时会自动绕过本地 HTTP 代理
- 运行日志写入 `logs/app.log`，该目录不会被 mygit 提交
