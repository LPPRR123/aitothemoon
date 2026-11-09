# AI 改地形数据包的闭环：实现说明

> 给 Cursor（或任何写代码的 AI）的实现说明。目标版本：Java 版 **1.20.4**，服务端 **Paper 1.20.4**。
> 这份说明只讲"怎么搭这条流水线"，不讲具体地形怎么调。

## 0. 要做成什么样

AI 改世界生成数据包（JSON）→ 用**真实的 Paper 1.20.4 测试服**生成一块区域 → 导出方块、高度、群系 → 画成图、算出数字 → AI 对照验收标准再改。一轮几分钟，全程不用人点。

```mermaid
flowchart LR
    A["AI 改 worldgen/datapack"] --> B["删旧世界<br/>放数据包、固定种子"]
    B --> C["启动 Paper 1.20.4"]
    C --> D["Chunky 生成 1000×1000"]
    D --> E["WgExport 插件导出<br/>高度 / 地表方块 / 群系 / 剖面"]
    E --> F["关服"]
    F --> G["画图 + 算指标<br/>对照 targets.yaml"]
    G --> H["report.md + 图"]
    H --> A
    H -. 每 5 轮 .-> P["人进游戏走一圈<br/>写 feedback.md"]
    P --> A
```

**为什么不用第三方渲染器/仿真器**：很多工具不支持 1.20.4，而且仿出来的和游戏实际生成的不一定一样。直接用真服务端跑，AI 看到的就是玩家会看到的。

---

## 1. 目录和命令

```
worldgen/
├─ targets.yaml        验收标准（人写，AI 不能改）
├─ feedback.md         人进游戏后的反馈（人写，AI 每轮必读）
├─ log.md              每轮一行：改了什么、为什么、关键数字变化（AI 写，进 git）
├─ AI_RULES.md         给 AI 的规则（第 7 节的内容，放进 Cursor rules）
├─ datapack/           AI 改的数据包，就是这个文件夹整个拷进世界
│  ├─ pack.mcmeta
│  └─ data/minecraft/...
├─ vanilla/            原版 1.20.4 的 worldgen JSON，只读参考（脚本生成，不进 git）
└─ runs/               每轮输出（不进 git）
   ├─ 0001-s20261109/  第几轮-种子
   │  ├─ meta.json  columns.bin  palette.json  sections/*.bin   ← 插件导出的原始数据
   │  ├─ biome.png  height.png  surface.png  slope.png  overview.png  section-*.png
   │  ├─ diff-height.png     和上一轮的高度差
   │  ├─ metrics.json  report.md  server.log
   │  └─ datapack.zip        这一轮用的数据包快照
   └─ latest -> 0001-s20261109
tools/wgexport/        导出插件（Java 源码 + 编译好的 jar，做法同 tools/testmenus）
scripts/worldgen/
├─ setup.ts            准备 worldgen-server/ 和 worldgen/vanilla/
├─ round.ts            跑一轮（核心）
├─ verify.ts           换种子验证（跑 targets.yaml 里的 verify_seeds）
├─ render.ts           原始数据 → PNG
├─ metrics.ts          原始数据 → metrics.json，对照 targets.yaml
├─ report.ts           metrics + 上一轮 → report.md
└─ play.ts             把某一轮的世界开起来给人进去走
```

`package.json` 加这些命令：

| 命令 | 作用 |
|---|---|
| `npm run worldgen:setup` | 下载 Paper 1.20.4、Chunky，拷 WgExport，生成原版参考 JSON |
| `npm run worldgen:round` | 用 targets.yaml 里的主种子跑一轮，输出到 `worldgen/runs/NNNN-sSEED/` |
| `npm run worldgen:round -- --seed 42` | 指定种子跑一轮 |
| `npm run worldgen:verify` | 用 `verify_seeds` 里每个种子各跑一轮，汇总成一张表 |
| `npm run worldgen:play -- --run 12` | 用第 12 轮的数据包和种子重新生成并开服，人进去看 |

PNG 用 `pngjs`（纯 JS，Windows 也能直接用），YAML 用项目里已有的 `yaml`。

**注意**：不要复用机器人的 `test-server/`，那个是超平坦世界。地形测试服单独放在 `worldgen-server/`（加进 `.gitignore`），端口用 25566，两个可以同时跑。

---

## 2. 第 1 步：准备测试服（`setup.ts`）

1. 下载 Paper 1.20.4 最新构建，做法照抄 `scripts/setup-test-server.ts`（PaperMC fill v3 接口 + sha256 校验）。
2. 下载 **Chunky**：选 Modrinth / Hangar 上明确标了支持 1.20.4 的版本，**在脚本里写死版本号和 sha256**，不要取"最新"。
3. 拷 `tools/wgexport/WgExport.jar` 到 `plugins/`。
4. 写 `server.properties`：

   ```properties
   online-mode=false
   server-port=25566
   server-ip=127.0.0.1
   level-type=minecraft\:normal
   level-seed=（每轮由 round.ts 改写）
   generate-structures=true
   allow-nether=false
   spawn-monsters=false
   view-distance=4
   simulation-distance=4
   max-players=2
   white-list=true
   ```
   `bukkit.yml` 里 `allow-end: false`。不生成下界和末地，开服更快。

5. 生成原版参考 JSON 到 `worldgen/vanilla/`。1.20.4 的原版群系、地形设置是写在代码里的，jar 里没有现成 JSON。两种来源，选一个：
   - **官方数据生成器**（推荐）：下载 Mojang 原版 1.20.4 `server.jar`（不是 Paper），运行
     `java -DbundlerMainClass=net.minecraft.data.Main -jar server.jar --server --reports --output <临时目录>`，
     把输出里的 `data/minecraft/worldgen/`、`reports/biome_parameters/`（多噪声群系参数）整理进 `worldgen/vanilla/`。
     *实现时确认这两个目录在 1.20.4 的输出里实际叫什么。*
   - 备选：misode/mcmeta 仓库对应 1.20.4 的 data 标签。

6. 如果 `worldgen/datapack/` 还不存在，建一个只有 `pack.mcmeta` 的空数据包（1.20.3–1.20.4 的 `pack_format` 是 **26**）。空数据包跑出来就是原版地形，作为第 0 轮基准。

---

## 3. 第 2 步：跑一轮（`round.ts`）

按顺序：

1. **检查数据包**：所有 JSON 能解析（不能有注释、不能有尾逗号）；`pack.mcmeta` 的 `pack_format` 是 26。解析失败直接退出，把文件名和错误位置打出来，不开服。
2. **检查改动范围**（第 6 节"分层做"的硬约束）：用 `git diff` 看 `worldgen/datapack/` 里改了哪些文件，不在当前阶段允许范围里的，拒绝跑并说明（`--force` 可以跳过）。
3. **检查人工把关**（第 6 节）：距离上次 `feedback.md` 更新已经跑了 5 轮或以上，拒绝跑，提示"请进游戏看看，然后更新 feedback.md"。`--force` 可以跳过，但会写进 `log.md`。
4. **删世界**：删掉 `worldgen-server/world`（以及 `world_nether`、`world_the_end`，如果有）。
5. **放数据包**：把 `worldgen/datapack/` 整个拷到 `worldgen-server/world/datapacks/aitothemoon-worldgen/`。**必须在第一次开服之前放好**——世界生成的设置在创建世界时就定了，之后再放数据包，已经生成的区块不会变。
6. **改种子**：改写 `server.properties` 的 `level-seed`（只在创建世界时生效，所以第 4 步必须删世界）。
7. **开服**：`java -Xmx4G -jar paper.jar --nogui`，cwd 是 `worldgen-server/`，stdout/stderr 全部写进本轮的 `server.log`。
8. **识别数据包报错**：1.20.4 数据包有错时，服务端可能直接拒绝加载世界（日志里有 `Failed to load datapacks` 之类，并提示 `--safeMode`），也可能只是跳过某个文件、继续用原版的（日志里会有 `Couldn't parse` / `Failed to parse` 和文件路径）。**两种都算这轮失败**：把相关日志行（前后各几行）整理进 `report.md`，退出码非 0。不要让"悄悄退回原版"的结果被当成正常结果。*实现时用一个故意写错的 JSON 实际跑一次，确认 1.20.4 的报错原文，再写匹配规则。*
9. **等开服完成**：日志出现 `Done (` 。
10. **生成 + 导出 + 关服**：控制台输入 `wgrun`（见第 4 节），由插件按顺序做完 Chunky 生成、导出、关服。`round.ts` 只要等进程退出。设一个总超时（默认 15 分钟），超时就杀进程，算失败。
11. **画图、算指标、写报告**：依次调用 `render.ts`、`metrics.ts`、`report.ts`。
12. **存快照**：把这一轮的数据包打包成 `datapack.zip`，更新 `runs/latest`（Windows 上建软链接要权限，改成写一个 `runs/latest.txt` 里放目录名也行）。
13. **世界默认不保留**（1000×1000 的世界有几十到上百 MB）。加 `--keep-world` 时才把 `world/` 拷进本轮目录。

**确定性检查**（做完第 3 节后先跑一次）：同一个数据包、同一个种子连跑两轮，`metrics.json` 必须完全一样、`columns.bin` 的哈希一样。不一样说明流水线有问题（比如导出时区块还没生成完），先修好再往下做。

---

## 4. 第 3 步：导出插件 `WgExport`（`tools/wgexport`）

Java 17，Paper API 1.20.4，构建方式照 `tools/testmenus`。只有一个控制台命令：

```
wgrun [size=1000] [cx=0] [cz=0]
```

### 4.1 生成

- 用 Chunky 生成以 (cx, cz) 为中心、边长 size + 32 的正方形（多生成 16 格边，保证导出区域边上的树和装饰也放完了）。
- 推荐用 Chunky 的 API（服务注册里取 `ChunkyAPI`，开任务，注册"生成完成"回调）；如果拿不到 API，退一步：插件在控制台执行 `chunky world world`、`chunky center`、`chunky radius`、`chunky shape square`、`chunky start`，再监听 Chunky 的完成提示。*实现时按所选 Chunky 版本确认 API 和完成提示的原文。*
- 生成完成后再开始导出。

### 4.2 导出的数据

坐标范围：x ∈ [cx − size/2, cx + size/2)，z 同理，共 size × size 列。

**每列记这些**（`columns.bin`，小端，按 z 行、x 列排列）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `groundY` | int16 | **地面高度**：从最高的非空气方块往下找，跳过树叶、原木、植物、雪层、所有没有碰撞箱的方块、液体，找到的第一个实心方块的 y |
| `waterY` | int16 | 地面上方有水时，水面最高的 y；没有水是 −32768 |
| `topBlock` | uint16 | 从天空往下看到的第一个非空气方块（可能是树叶、雪、水），在 `palette.blocks` 里的下标 |
| `groundBlock` | uint16 | `groundY` 那个方块的下标（草方块、石头、沙子……） |
| `biome` | uint16 | 地面高度处的群系，在 `palette.biomes` 里的下标 |

**剖面**（`sections/<名字>.bin`）：按 `targets.yaml` 里的 `sections` 配置，每条线上每一列从 minY 到 maxY 的完整方块（uint16 下标），共 size × 384 个。

**`palette.json`**：

```json
{
  "blocks": [{ "id": "minecraft:grass_block", "color": "#7fb238" }],
  "biomes": ["minecraft:plains", "aitothemoon:snow_peaks"]
}
```
方块颜色用地图颜色：Paper API 里有 `BlockData#getMapColor()` 就用它；没有的话 color 留空，渲染脚本用自己的颜色表。

**`meta.json`**：种子、中心、size、`minY`/`maxY`（−64 / 320）、`seaLevel`（读 `world.getSeaLevel()`，因为数据包可能改了海平面）、Minecraft 和 Paper 版本、数据包的哈希、生成用时、导出用时。

### 4.3 要小心的地方

- **群系名**：1.20.4 的 Bukkit `Biome` 枚举遇到数据包自定义群系只会返回 `CUSTOM`。要拿真实的群系 ID，用 Paper 的 `Bukkit.getUnsafe().getBiomeKey(world, x, y, z)`（返回 NamespacedKey）。*实现时确认这个方法在 1.20.4 Paper 上可用；不可用就退到 NMS。*
- **线程**：`World` 只能在主线程读。做法：每 tick 处理几个区块，主线程上取 `ChunkSnapshot` 和群系，算地面高度这种纯计算放到异步线程。不要一次在主线程上读完 100 万列，会卡死看门狗。
- 导出结束后写一个 `done.json`（含行数校验），再执行 `stop`。`round.ts` 看到 `done.json` 才认为导出成功。

---

## 5. 第 4 步：画图和算指标

### 5.1 图（`render.ts`，1 像素 = 1 格）

| 文件 | 内容 |
|---|---|
| `height.png` | 高度图：按高度上色 + 山体阴影（西北光源）+ 每 16 格一条等高线；水面用蓝色，按水深调深浅 |
| `biome.png` | 群系图：原版群系用固定颜色表，自定义群系按名字哈希出颜色；图例写在 `report.md` 里 |
| `surface.png` | 俯视地表：用 `topBlock` 的地图颜色，接近游戏里地图的样子 |
| `slope.png` | 坡度分类：平缓 / 陡坡 / 悬崖 三种颜色，水面灰色 |
| `overview.png` | 上面四张缩到 500×500 拼成 2×2，标上剖面线位置、最大可建平地的方框、`targets.yaml` 里的区域和道路。**AI 主要看这张** |
| `section-<名字>.png` | 剖面：横轴是沿线位置，纵轴 y（−64 到 320，纵向放大 2 倍），按方块上色，画出海平面线和每 32 格的刻度 |
| `diff-height.png` | 和上一轮（同种子）的地面高度差：变高红、变低蓝、不变白。用来看"这一处改动到底影响了哪里" |

### 5.2 指标（`metrics.ts` → `metrics.json`）

下面"陆地"指没有被水盖住的列（`waterY` 为空）。"坡度"用一列和上下左右四格的地面高度差的最大值：

| 指标 | 定义 |
|---|---|
| `ocean_share` | 群系属于 `#minecraft:is_ocean` 的列占比（标签内容从原版参考 JSON 里读） |
| `water_share` | 被水盖住的列占比（海、河、湖都算） |
| `river_share` | 群系属于 `#minecraft:is_river` 的列占比 |
| `land_height` | 陆地地面高度的 p5 / p25 / p50 / p75 / p95 / 最大值，以及每 16 格一档的直方图 |
| `flat_share` | 陆地中坡度 ≤ 1 的占比 |
| `steep_share` | 陆地中坡度 2–3 的占比 |
| `cliff_share` | 陆地中坡度 ≥ 4 的占比 |
| `biome_share` | 每个群系的占比，按占比排序 |
| `group_share.<组名>` | `targets.yaml` 里自定义的群系组的占比（比如"雪山"） |
| `largest_flat_square` | 最大的一块"可建平地"正方形的边长和中心：里面每一列都是陆地、高于海平面、坡度 ≤ 1，且整块高差 ≤ 3。用动态规划求最大全 1 正方形 |
| `largest_landmass_share` | 最大一块连通陆地占全部陆地的比例（防止碎成一堆小岛） |
| `regions.<名字>.*` | `targets.yaml` 里每个矩形区域内：平地占比、悬崖占比、高差、主要群系 |
| `corridors.<名字>.*` | 每条道路（折线 + 宽度）沿线：最大单格高差、总爬升、水面占比、最长一段连续陡坡 |

### 5.3 报告（`report.ts` → `report.md`）

- 第一行：**通过 / 不通过**，几项不通过。
- 验收表：每项检查的目标、本轮值、上一轮值、变化、是否通过。
- 关键数字的变化（只列变化超过一定幅度的）。
- 数据包报错（如果有）。
- 本轮和上一轮的数据包差异（改了哪些文件）。
- 群系颜色图例。

---

## 6. 第 5 步：验收标准 `targets.yaml`

人来写，AI 只读。示例：

```yaml
# 用人话写下想要什么，AI 改之前要读
goal: |
  一块以温带平原为主的大陆，北边是一整片雪山。
  中部有一条东西向的主路，地势平缓，能在路边放下主城。
  海不要太多，但南边要有海岸线。

seed: 20261109              # 日常迭代用这一个种子
verify_seeds: [1, 42, 777]  # 定稿前换种子验证
area: { center: [0, 0], size: 1000 }
current_stage: 1            # 当前在第几阶段，见下面 stages

stages:
  1: { name: 大地形, allow: ["data/minecraft/worldgen/noise_settings/", "data/minecraft/worldgen/density_function/", "data/minecraft/worldgen/noise/"] }
  2: { name: 地表方块, allow: ["data/minecraft/worldgen/noise_settings/overworld.json"] }   # 只改 surface_rule
  3: { name: 群系, allow: ["data/minecraft/dimension/", "data/minecraft/worldgen/biome/", "data/aitothemoon/worldgen/biome/"] }
  4: { name: 树和装饰, allow: ["data/minecraft/worldgen/biome/", "data/minecraft/worldgen/configured_feature/", "data/minecraft/worldgen/placed_feature/", "data/aitothemoon/"] }

sections:
  - { name: z0,   axis: x, at: 0 }      # z=0 这条线，沿 x 方向
  - { name: zN,   axis: x, at: -300 }
  - { name: x0,   axis: z, at: 0 }
  - { name: city, axis: x, at: 40 }     # 穿过主城预定位置

groups:
  雪山: [minecraft:snowy_slopes, minecraft:frozen_peaks, minecraft:jagged_peaks, minecraft:grove]

regions:
  north:    { x: [-500, 500], z: [-500, -200] }
  城址:     { x: [-60, 140], z: [-60, 140] }

corridors:
  主路: { points: [[-480, 20], [0, 20], [480, 20]], width: 9 }

checks:   # stage 表示从第几阶段开始检查
  - { name: 海洋不要太多,   metric: ocean_share,                     max: 0.20,             stage: 1 }
  - { name: 有海岸线,       metric: ocean_share,                     min: 0.05,             stage: 1 }
  - { name: 不要碎成小岛,   metric: largest_landmass_share,          min: 0.85,             stage: 1 }
  - { name: 主城放得下,     metric: largest_flat_square.size,        min: 96,               stage: 1 }
  - { name: 城址平整,       metric: regions.城址.flat_share,         min: 0.70,             stage: 1 }
  - { name: 主路够平,       metric: corridors.主路.max_step,         max: 2,                stage: 1 }
  - { name: 也别全是平地,   metric: flat_share,                      min: 0.35, max: 0.65,  stage: 1 }
  - { name: 要有像样的山,   metric: land_height.p95,                 min: 150,              stage: 1 }
  - { name: 雪山占三成,     metric: group_share.雪山,                min: 0.25, max: 0.35,  stage: 3 }
  - { name: 雪山在北边,     metric: regions.north.group_share.雪山,  min: 0.70,             stage: 3 }
```

写标准时注意：**能加上限的都加上限**（比如平地比例 0.35–0.65），不然 AI 最省事的办法就是把整个世界压平。

---

## 7. 给 AI 的规则（写进 `worldgen/AI_RULES.md`，并放进 Cursor rules）

每一轮 AI 按这个顺序做：

1. 读 `targets.yaml`（尤其 `goal` 和 `current_stage`）、`feedback.md`、`log.md` 最近 10 轮、上一轮的 `report.md` 和 `overview.png`，需要时再看剖面图。
2. **先写假设再动手**：在 `log.md` 新起一行，写"改什么、为什么、预计哪个数字往哪边变、图上哪里会变"。
3. **一轮只改一件事**，只改当前阶段允许的文件。前面阶段已经定好的东西不动。
4. `npm run worldgen:round`。
5. 对照假设看结果：预计的变化有没有发生？有没有意外的副作用（看 `diff-height.png`）？把实际结果补进 `log.md` 那一行。
6. 结果变差就回退这次改动（数据包在 git 里，`git checkout` 即可），在 `log.md` 记下"这条路不行"，换一个思路。
7. 当前阶段的检查全部通过后，跑 `npm run worldgen:verify`。所有验证种子都通过（或者偏差在可接受范围内）才算这个阶段完成；然后停下来，等人确认后再把 `current_stage` 加 1（这个数字由人改）。

不能做的事：

- 不能改 `targets.yaml`、`feedback.md`、`scripts/worldgen/` 里的指标算法、WgExport 插件。数字不达标只能改数据包。
- 不能只盯着数字。数字是底线，不是目标。`goal` 里写的感觉、`feedback.md` 里人说的话，优先级高于"再多 2% 平地"。
- 遇到 `round.ts` 因为"该人工把关了"拒绝运行，就停下来，告诉人该看哪几处（坐标见 `report.md`），不要用 `--force` 绕过。
- 一个种子好看不算数，定稿前必须换种子验证。

---

## 8. 人工把关（`play.ts`）

俯视图和剖面图只能看布局，看不出玩家站在地上的感觉。所以每 5 轮左右，人要进游戏走一圈。

- `npm run worldgen:play -- --run 12`：用第 12 轮的数据包和种子重新生成（流程同 `round.ts`，但不关服），开服后打印出：
  - 连接地址 `127.0.0.1:25566`（只监听本机，别把这个端口开到公网）；
  - 几个值得看的地方的 `/tp` 指令：最大可建平地中心、最高峰、最陡的悬崖、每条剖面线的中点、每个 `regions` 的中心、主路的起点和终点。
- 先在控制台 `whitelist add <你的名字>`、`op <你的名字>`，进去后可以 `/gamemode spectator` 飞着看，再切生存走一走。
- 看完写进 `feedback.md`，越具体越好，比如"城址南边那道坎太硬了，走路得跳三次""雪山从远处看像一堵墙，没有层次"。写了 `feedback.md`，`round.ts` 的 5 轮计数就清零。
- 遇到满意的一轮，在 `feedback.md` 里写"参考轮：12"。之后 AI 改的时候要拿参考轮的图对比，别越改越偏。

**最大的风险**是 AI 把数字越调越达标，地形却越来越没意思。所以 `feedback.md` 的优先级高于 `targets.yaml` 的数字，最终拍板的是人。

---

## 9. 实现顺序（每一步做完都要能跑）

| 步骤 | 内容 | 做完的标准 |
|---|---|---|
| M1 | `setup.ts` + `round.ts` 的开服、关服、删世界、放数据包、改种子、报错识别（先不导出，Chunky 用控制台命令） | 空数据包能跑完一轮；故意写错一个 JSON，`report.md` 里能看到报错原文，退出码非 0 |
| M2 | WgExport 插件：`wgrun`、导出、`done.json` | 导出的 `columns.bin` 大小 = size² × 10 字节；同一种子连跑两次哈希一样 |
| M3 | `render.ts` | 原版地形跑出来的 `surface.png` 和游戏里的地图看起来一致；剖面图上能看到海平面和山体 |
| M4 | `metrics.ts` + `targets.yaml` + `report.ts` | 指标有单元测试（用手造的小数组：一块平地、一道悬崖、一片海，结果对得上）；报告里有上一轮对比 |
| M5 | 改动范围检查、5 轮人工把关、`verify.ts`、`play.ts` | 改了不允许的文件会被拒绝；第 6 轮不写 feedback 会被拒绝；三个种子能出汇总表 |
| M6 | `AI_RULES.md` + Cursor rules | 让 AI 从原版开始，按规则跑 3 轮，`log.md` 里每轮都有假设和结果 |

单元测试放 `test/worldgen-*.test.ts`，沿用 `npm test`。M1–M5 的端到端跑一次大约几分钟，不放进 `npm test`。

---

## 10. 参考：1.20.4 世界生成的文件在哪

AI 改之前先在 `worldgen/vanilla/` 里找到对应的原版文件，复制到 `worldgen/datapack/` 再改，不要从零写。

| 想改什么 | 文件 |
|---|---|
| 海平面、地下含水层、地表方块规则（`surface_rule`）、噪声路由 | `worldgen/noise_settings/overworld.json` |
| 大陆度、侵蚀度、山脊、地形高低起伏（`offset` / `factor` / `jaggedness` 的样条） | `worldgen/density_function/overworld/*.json` |
| 各种噪声的频率和振幅 | `worldgen/noise/*.json` |
| 群系分布（哪种气候参数出哪个群系） | `dimension/overworld.json`：把 `biome_source` 从 `"preset": "minecraft:overworld"` 改成写明每个群系参数的完整列表（原版参数从生成器的 `biome_parameters` 报告里拿） |
| 单个群系的颜色、降水、生物、装饰列表 | `worldgen/biome/<名字>.json` |
| 树、矿、花草等装饰 | `worldgen/configured_feature/`、`worldgen/placed_feature/` |

以上路径都在 `data/minecraft/` 下面；自定义的新群系、新装饰放在 `data/aitothemoon/` 下面。
