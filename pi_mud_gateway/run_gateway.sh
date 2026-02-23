#!/bin/bash
# 启动 Gateway 的快捷脚本
# 这个脚本会进到 pi-coding-agent 项目里，借用它本地安装的依赖和 npx tsx 来运行我们的 Gateway

echo "Starting Pi MUD Gateway..."

# 1. 检查 MUD 端口是否可用
if ! nc -z 127.0.0.1 5555; then
    echo "Warning: Cannot connect to 127.0.0.1:5555"
    echo "Please make sure your FluffOS server is running before starting the Gateway!"
fi

# 获取当前脚本所在目录的绝对路径
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# 2. 切换到 pi 目录，使用其 node_modules 和 tsx 来运行
cd "$DIR/../pi/packages/coding-agent" || { echo "Failed to cd into pi directory"; exit 1; }

echo "Running mud_gateway.ts from $(pwd)"
npx tsx "$DIR/mud_gateway.ts"
