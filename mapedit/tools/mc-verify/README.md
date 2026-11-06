# 游戏内验证

用原版服务端加载 mapedit 导出的存档，再把游戏重新保存的结果和原始数据逐方块对比。

```bash
cd mapedit
python3 tools/mc-verify/setup.py 1.21.4 26.3          # 下载服务端 + Mojang Java 25（Linux）
SAVE=$PWD/exports/TheWorld
# 1) 强制升级：游戏读取并重写每个区块（存档版本比游戏旧时才会真正执行）
python3 tools/mc-verify/mctest.py 26.3 $SAVE upgrade
# 2) 逐方块对比（26.x 会把维度搬进 dimensions/minecraft/...，diff 能识别两种布局）
./target/release/mapedit diff $SAVE mc-verify-work/srv-26.3/TheWorld-test --dim overworld
# 3) 运行测试：强制加载区块、加速随机刻，然后再对比，看玩起来会发生什么变化
python3 tools/mc-verify/mctest.py 26.3 $SAVE run \
  "forceload add -192 -192 191 191" "gamerule random_tick_speed 300" "sleep:60"
```

`mctest.py` 会打印服务端启动结果、每条命令的输出，以及日志里所有警告和错误。
`nbtdump.py REGION.mca CX CZ` 可以打印一个区块的 NBT 结构。
