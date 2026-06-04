# mygit 示例 - 版本文件检测

## 场景

变更中包含版本号相关文件（`package.json`），脚本提示用户应使用版本发布命令。

## 输入

```bash
bun run mygit
```

此时 `git status --porcelain` 输出：

```text
 M package.json
 M src-tauri/tauri.conf.json
 M src-tauri/Cargo.toml
 M src/views/Dashboard.vue
```

## 完整输出

```text
🚀 AI Git 提交工具启动

📝 正在检查代码变更...

发现 4 个文件变更：
  修改: package.json
  修改: src-tauri/tauri.conf.json
  修改: src-tauri/Cargo.toml
  修改: src/views/Dashboard.vue

⚠️  警告：检测到版本号相关文件的变更
   如果您要发布新版本，请使用以下命令：
   - bun run release:tag  （创建版本标签）
   - 或触发 mytag Hook

   这些命令会自动：
   1. 生成符合规范的版本号（1.0.YYYYMMDD.NNN）
   2. 更新所有配置文件中的版本号
   3. 创建 Git 标签并推送

   如果您确定要继续普通提交，请按回车继续...
```

## 用户操作

- **按回车**：继续正常提交流程
- **Ctrl+C**：取消操作，使用 `bun run release:tag` 进行版本发布
