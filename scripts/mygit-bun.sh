#!/usr/bin/env bash
# WSL 下优先使用 Linux 版 bun，避免 Windows npm 全局 bun 的 UNC 路径问题
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENTRY="scripts/git-auto-commit.ts"
if [[ $# -ge 1 && "$1" == *.ts ]]; then
  ENTRY="$1"
  shift
fi

if [[ -x "${HOME}/.bun/bin/bun" ]]; then
  exec "${HOME}/.bun/bin/bun" run "$ENTRY" "$@"
fi

if command -v bun >/dev/null 2>&1; then
  BUN_PATH="$(command -v bun)"
  case "${BUN_PATH}" in
    /mnt/c/*|/mnt/C/*)
      echo "⚠️  检测到 Windows 版 bun（${BUN_PATH}）。" >&2
      echo "   已启用 WSL 回退执行 git；推荐安装 Linux bun 以避免 UNC 路径问题：" >&2
      echo "   curl -fsSL https://bun.sh/install | bash" >&2
      ;;
  esac
  exec bun run "$ENTRY" "$@"
fi

echo "❌ 未找到 bun。请安装: curl -fsSL https://bun.sh/install | bash" >&2
exit 1
