# mygit 示例 - 正常提交流程

## 场景

开发者修改了 3 个文件后，执行 `bun run mygit` 自动提交。

## 输入

```bash
bun run mygit
```

此时 `git status --porcelain` 输出：

```text
 M src/views/GradeSubject.vue
 M src/views/GradeSubjectPlanView.vue
?? src-service/db/migrations/20260319_000005.sql
```

## AI 请求

发送给 AI 的用户消息：

```text
请根据以下代码变更生成一个简洁的 Git 提交信息：

变更摘要：
- 新增 1 个文件
- 修改 2 个文件

变更文件列表：
- 修改: src/views/GradeSubject.vue
- 修改: src/views/GradeSubjectPlanView.vue
- 新增: src-service/db/migrations/20260319_000005.sql

要求：
1. 使用中文
2. 第一行是简短的标题（不超过 50 字符）
3. 使用常见的提交类型前缀（如：feat、fix、docs、style、refactor、test、chore）
4. 描述要清晰、准确
```

## AI 响应

```text
feat: 支持小数形式的周课时配置

- 新增数据库迁移文件，允许科目周课时使用小数
- 修改成绩科目相关视图文件以适应小数课时
```

## 完整输出

```text
🚀 AI Git 提交工具启动

📝 正在检查代码变更...

发现 3 个文件变更：
  修改: src/views/GradeSubject.vue
  修改: src/views/GradeSubjectPlanView.vue
  新增: src-service/db/migrations/20260319_000005.sql

🤖 正在使用 AI 生成提交信息...

提交信息：
──────────────────────────────────────────────────
feat: 支持小数形式的周课时配置

- 新增数据库迁移文件，允许科目周课时使用小数
- 修改成绩科目相关视图文件以适应小数课时
──────────────────────────────────────────────────

📦 正在添加变更到暂存区...
💾 正在创建提交...
🚀 正在推送到远程仓库...
📡 远程仓库: origin, 分支: dev0319

✨ 提交并推送成功！
```

## 执行的 Git 命令

```bash
git add .
git commit -m "feat: 支持小数形式的周课时配置\n\n- 新增数据库迁移文件..." --no-verify
git -c http.sslVerify=false push --no-verify origin dev0319
```
