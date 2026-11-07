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

## 真实客户端截图（Linux，无显示器）

```bash
apt-get install -y xvfb xdotool mesa-vulkan-drivers libvulkan1 libgl1-mesa-dri
export MC_HOME=$PWD/mc-verify-work
python3 tools/mc-verify/getclient.py mc-verify-work/26.3.json $MC_HOME/client   # 版本 json 从 piston-meta 下载
mkdir -p $MC_HOME/client/game/saves && cp -r exports/Scenes $MC_HOME/client/game/saves/
Xvfb :99 -screen 0 1280x720x24 &
tools/mc-verify/runclient.sh Scenes &                # 软件 Vulkan 渲染，进入存档约 1 分钟
# 点掉「升级前备份」和「实验性设置」提示后，按 F1 隐藏界面：
DISPLAY=:99 xdotool key F1
python3 tools/mc-verify/shots.py examples/scenes shots 45   # 按每个场景的 view 机位传送并截图
```

客户端需要访问 piston-meta / piston-data.mojang.com、libraries.minecraft.net 和 resources.download.minecraft.net（会跳过音效资源）。离线运行时正版服务相关的报错可以忽略。
`options.txt` 里建议设 `fov:-0.5`（垂直 50°，约等于 `view` 的水平 80°）和 `renderDistance:16`。
`nbtdump.py REGION.mca CX CZ` 可以打印一个区块的 NBT 结构。
