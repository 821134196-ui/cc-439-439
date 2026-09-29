#!/usr/bin/env bash
# 单条本地启动命令：生成申请、归还、隔离等样例并启动服务。
# 用法：./run.sh [端口]
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8000}"

# 首次运行自动 seed；需要重置演示数据时执行：./run.sh --reseed
if [ "${1:-}" = "--reseed" ]; then
  rm -rf data
  exec python3 -m app --port "${2:-8000}"
fi

exec python3 -m app --port "$PORT"
