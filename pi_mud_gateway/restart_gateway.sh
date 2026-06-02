#!/bin/bash
# 完全重启 Gateway - 清除断点，从 Turn 1 重新开始

echo "Restarting Pi MUD Gateway (clean start)..."

# 获取当前脚本所在目录
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# 删除 checkpoint 文件
if [ -f "$DIR/checkpoint.json" ]; then
    echo "Removing checkpoint.json..."
    rm "$DIR/checkpoint.json"
fi

# 检查 MUD 端口
if ! nc -z 127.0.0.1 5555; then
    echo "Warning: Cannot connect to 127.0.0.1:5555"
    echo "Please make sure your FluffOS server is running!"
fi

# 切换到 pi 目录运行
cd "$DIR/../pi/packages/coding-agent" || { echo "Failed to cd into pi directory"; exit 1; }

echo "Running mud_gateway.ts from $(pwd)"
echo "Starting from Turn 1 (no checkpoint)..."
npx tsx "$DIR/mud_gateway.ts"
