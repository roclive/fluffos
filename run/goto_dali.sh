#!/bin/bash
# 自动登录到大理王府并拜师褚万里的脚本
HOST="localhost"
PORT=5555

echo "=== 侠客行: 自动拜师大理段氏 ==="

{
    sleep 2; echo "n"           # GB编码
    sleep 2; echo "roclive"     # 英文名
    sleep 2; echo "test1234"    # 密码
    sleep 2; echo "y"           # 确认重连（如果已在线）

    # 登录后应该直接在 /d/dali/wangfu1 (王府大门)
    sleep 3
    echo "look"                 # 查看当前位置
    sleep 2

    # 直接拜褚万里为师（save file里已经设了dali/trust=200, employee=1）
    echo "bai zhu wanli"
    sleep 3

    # 查看状态
    echo "look"
    sleep 2
    echo "score"
    sleep 5

} | telnet $HOST $PORT 2>&1echo ""
echo "=== 脚本完成 ==="