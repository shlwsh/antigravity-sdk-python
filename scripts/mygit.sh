#!/bin/bash

# 设置出错即退出
set -e

echo "🚀 AI Git 提交工具启动"

# 获取工作空间路径
WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE_DIR"

# 1. 验证 Git 仓库
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "❌ 错误: 当前目录不是一个有效的 Git 仓库"
    exit 1
fi

# 检查依赖
if ! command -v jq >/dev/null; then
    echo "⚠️ 警告: 未找到 jq 命令。AI 生成功能将不可用，将使用托底提交。"
    HAS_JQ=false
else
    HAS_JQ=true
fi

if ! command -v curl >/dev/null; then
    echo "❌ 错误: 未找到 curl 命令，请先安装 curl。"
    exit 1
fi

# 2. 加载配置
ENV_FILE=".env.mygit"
if [ ! -f "$ENV_FILE" ]; then
    echo "❌ 错误: 找不到配置文件 $ENV_FILE"
    echo "请在项目根目录创建该文件，并包含 DASHSCOPE_API_KEY, DASHSCOPE_BASE_URL, DASHSCOPE_MODEL"
    exit 1
fi

# 读取配置（解析 .env 文件并去掉注释、空格和引号）
while IFS='=' read -r key value; do
    key=$(echo "$key" | xargs)
    value=$(echo "$value" | xargs)
    if [[ ! "$key" =~ ^# ]] && [ -n "$key" ]; then
        value=$(echo "$value" | tr -d '\r' | sed 's/^"//' | sed 's/"$//' | sed "s/^'//" | sed "s/'$//")
        export "$key=$value"
    fi
done < "$ENV_FILE"

if [ -z "$DASHSCOPE_API_KEY" ] || [ -z "$DASHSCOPE_BASE_URL" ] || [ -z "$DASHSCOPE_MODEL" ]; then
    echo "❌ 错误: 配置文件 $ENV_FILE 中缺少必填项 (DASHSCOPE_API_KEY, DASHSCOPE_BASE_URL, DASHSCOPE_MODEL)"
    exit 1
fi

# 移除 URL 末尾可能的斜杠
DASHSCOPE_BASE_URL=${DASHSCOPE_BASE_URL%/}

# 3. 检测变更
echo "📝 正在检查代码变更..."
CHANGES=$(git status --porcelain)

if [ -z "$CHANGES" ]; then
    echo "✅ 没有检测到代码变更"
    exit 0
fi

# 统计变更文件数量
CHANGE_COUNT=$(echo "$CHANGES" | wc -l)
echo "发现 $CHANGE_COUNT 个文件变更："
echo "$CHANGES" | while read -r line; do
    status=$(echo "$line" | awk '{print $1}')
    file=$(echo "$line" | awk '{print $2}')
    case "$status" in
        M|AM|MM) echo "  修改: $file" ;;
        A) echo "  新增: $file" ;;
        D|AD) echo "  删除: $file" ;;
        ??) echo "  未跟踪: $file" ;;
        *) echo "  其他: $file" ;;
    esac
done

# 4. 版本文件检测
if echo "$CHANGES" | grep -E "package\.json|src-tauri/tauri\.conf\.json|src-tauri/Cargo\.toml" > /dev/null; then
    echo "⚠️ 检测到版本相关文件变更，建议使用相关的版本发布命令"
    # 按要求这里提示并退出
    echo "⚠️ 请使用 \`bun run release:tag\` 或对应的工作流进行版本发布"
    exit 1
fi

# 5. 执行 Python 版 mygit
if command -v python3 >/dev/null 2>&1; then
    python3 "$WORKSPACE_DIR/scripts/mygit.py"
else
    echo "❌ 错误: 未找到 python3，无法运行优化版 mygit。"
    exit 1
fi

