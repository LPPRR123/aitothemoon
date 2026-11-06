# mapedit — 给 AI 用的 Minecraft 实时地图编辑器

一个用 Rust 写的 Minecraft 地图编辑器，通过 **MCP** 让 AI Agent（Claude Code、Claude Desktop 或任何 MCP 客户端）直接生成和修改地形。每次编辑都会**实时**显示在浏览器的 3D 预览里，可以撤销，最后**导出成原版 Java 存档**，单人模式直接打开。

思路来自 B 站视频《给AI用的Minecraft实时地图编辑器》（拆解见 [`../docs/theworld-video-analysis.md`](../docs/theworld-video-analysis.md)），代码从零实现，并在几个方向上做得比视频更多（见下文「比原版多了什么」）。

![3D 预览](docs/screenshots/viewer-overview.jpg)

## 快速开始

```bash
cd mapedit
cargo build --release          # 生成 target/release/mapedit（单文件，前端已内嵌）

# 跑一遍示例：2400×2400 外星峡谷世界 + 1600×1600 下界外域，92 次调用
./target/release/mapedit run examples/alien_canyon.json --serve
# 打开 http://localhost:8848/ 看 3D 预览；存档写到 ./exports/TheWorld
```

示例脚本在 4 核机器上大约 26 秒跑完。主世界写入约 9.1 亿个非空气方块，导出 52 个区域文件（主世界 36 个，下界 16 个）。

### 接入 Claude Code

```bash
claude mcp add mapedit -- /绝对路径/mapedit/target/release/mapedit mcp
```

然后直接对 Claude 说，例如：

> 在 2400×2400 的地图上做一个外星峡谷世界：北部雪山，一条断层峡谷和几个露天矿坑，河流向南流进大海，西边是紫色森林，旁边再做一个下界外域。做完导出存档。

`mcp` 模式下，3D 预览同时在 <http://localhost:8848/> 启动（端口被占用时会自动顺延，`--port` 可以指定，`--no-viewer` 可以关闭）。

### 接入 Claude Desktop / 其他客户端

stdio 方式（`claude_desktop_config.json`）：

```json
{ "mcpServers": { "mapedit": { "command": "/绝对路径/mapedit", "args": ["mcp"] } } }
```

HTTP 方式：先运行 `mapedit serve`，再把客户端指向 `http://localhost:8848/mcp`（Streamable HTTP，返回 JSON 响应）。

## 功能

### 48 个 MCP 工具

| 类别 | 工具 |
|---|---|
| 世界 | `world_create` `world_list` `world_info` `world_select` `world_delete` |
| 语义分区 | `zones_hex` `zone_set` `zones_list` —— 六边形区域 + 区域之间的关口（G01…），带地形预设 |
| WorldEdit 式 | `generate`（表达式）`box` `sphere` `cyl` `line` `replace` `biome` |
| Axiom 式笔刷 | `ridge`（山脊）`raise` `smooth` `flatten` `roughen` `terrace` `pit`（露天矿坑）`carve`（峡谷）`paint`（按高度/坡度/噪声规则上色）`overlay` |
| 水与路 | `river`（水位单调下降）`fill`（连通洪泛填海）`road`（坡度限制，过水自动架桥，`route:true` 用 A* 自动绕开陡坡） |
| 植被 | `forest`（17 种程序化树，成簇分布）`tree` `flora` |
| 结构 | `structure`（9 种程序化地标）`schem_load` `schem_save` `schem_list` `copy` `paste`（Sponge .schem v2/v3，带方块朝向的旋转） |
| **让 AI 看见** | `map`（俯视晕渲图，带区域边界和 ID 标注）`view`（3D 透视图）`probe` `stats` |
| 流程 | `history` `undo` `redo` `batch` `help` |
| 存档 | `export`（Anvil `.mca` + `level.dat`，多维度）`import`（读入已有 1.18+ 存档继续编辑） |

完整清单运行 `mapedit tools` 查看。参数语法会在 MCP 初始化时通过 `instructions` 字段发给模型，模型也可以调用 `help` 工具查询。

### 给 AI 用的参数语法

```text
点      "x,y,z" | "x,z"(y 取地表) | 关口 "G03" | 区域 "F2" | 加高 "G03+2"
路径    "G01 → 120,300 → G08"
区域    "all" | "zone:F1,F2" | "F2" | "rect:x0,z0,x1,z1" | "circle:x,z,r" | "G03:60" | "outside"
方块    "stone" | "60%stone,30%andesite,10%gravel" | "oak_log[axis=x]"
掩码    "stone,dirt" | "!air" | "#solid" "#liquid" "#foliage" "#plant" "#wood" "#existing"
表达式  "y <= height(x,z)"   "y <= 64 + 20*fbm(x,z,150) && y > 0"
        函数：noise fbm ridged worley rand height(区域设计高度) edge(到区域边界距离) top(当前地表) …
```

`y <= f(x,z)` 这种形式的表达式会被识别成「按列填充」，2400×2400 的地形底子几秒就能生成。

## 比原版多了什么

1. **AI 能看见自己的结果**：`map` 返回带区域/关口文字标注的俯视图（内置像素字体），`view` 返回任意机位的 3D 透视图。两者都是 MCP 的图片内容，模型可以按「规划 → 执行 → 看 → 修正」的循环工作，不用像视频里那样只拿到一个方块数。
2. **语义锚点**：区域和关口都能直接当作点、路径和区域参数使用，修路写 `"F5 → F2 → C0 → P1"` 就行。
3. **道路自动寻路**：`road route:true` 在地形上做 A* 搜索，代价函数考虑坡度和过水，然后平滑路径、限制坡度，过水自动架桥。
4. **真正的撤销/重做**：基于区块快照，区域划分的修改也能撤销；编辑失败会自动回滚；历史按快照内存（2 GB）和条数（500）限制。
5. **导入已有存档**：可以在现有世界上继续编辑，不只是从零生成。
6. **`batch` 批量调用**：一次请求执行多步编辑，每步仍然是独立的撤销点。
7. **stdio 和 HTTP 两种 MCP 传输**，预览页面也能直接调用工具（撤销、导出）。

## 3D 预览

![实时编辑](docs/screenshots/viewer-live-edit.jpg)

- 全图用降采样的 LOD 高度网格显示，相机附近按需加载逐方块的细节区块（面剔除、按面方向烘焙明暗、水体半透明）
- 通过 WebSocket 推送脏区块：Agent 每次编辑后，只重建被改动的区块，并用橙色框高亮编辑范围
- 区域边界、区域名和关口编号叠加显示；点击顶栏的区域按钮可以飞过去
- 左侧：图层开关、细节距离/雾/亮度、光标处的方块/区域/群系；右侧：修改日志、撤销、重做；导出存档对话框带进度条
- 快捷键：`T` 俯视，`O` 斜视，`F` 全图，`Ctrl/⌘+Z` 撤销，双击飞到该点

AI 侧拿到的图片：

| `map` | `view` |
|---|---|
| ![map](docs/screenshots/tool-map.jpg) | ![view](docs/screenshots/tool-view.jpg) |

## 存档导出说明

- 区块按 1.18+ 的分段调色板格式写入，默认 `DataVersion 4189`（1.21.4）。更新的游戏版本打开时，会通过 DataFixerUpper 自动升级区块（游戏会先提示备份）。目标版本可以用 `data_version` 和 `version_name` 参数指定。
- 不写光照（`isLightOn = 0`），由游戏在加载时重算。高度图也由游戏重算。
- 地图以外用虚空超平坦生成器，所以存档边界外是空的。
- 维度映射：第一个主世界 → `region/`，`the_nether` 世界 → `DIM-1/`，其他世界 → 数据包里的自定义维度（`mapedit:<名字>`，用 `/execute in mapedit:<名字> run tp @s 0 100 0` 进入）。
- 群系只接受原版 ID，非原版的群系在导出时会回退成 `plains`。

> 我在开发环境里验证过导出→导入的往返（方块、群系、区域文件布局），但这个环境装不了 Minecraft 客户端，所以**还没有在游戏里实际打开过导出的存档**。如果加载有问题，请把游戏日志反馈给我。

## 架构

```
src/
  blocks.rs   方块状态驻留注册表（u16 id）、分类、地图颜色
  world.rs    有界区块网格；16³ 分段，Uniform / 8 位调色板 / Raw 三种存储；撤销日志；脏区块跟踪
  zones.rs    六边形区域、关口、地形预设、混合后的设计高度场
  expr.rs     表达式解析和求值，按列形式识别
  spec.rs     点 / 路径 / 区域 / 方块模式 / 掩码的解析
  noise.rs    Perlin、fBm、ridged、Worley、RNG
  ops/        terrain.rs  water.rs  nature.rs  structures.rs  mod.rs（形状、generate、高度图读写）
  anvil.rs    .mca / level.dat 导出导入，自定义维度数据包
  render.rs   给 AI 的 PNG：晕渲俯视图 + 体素空间透视图
  mesh.rs     预览用的二进制区块网格和概览网格
  editor.rs   多世界会话、历史、事件
  tools.rs    48 个工具的 schema 和实现，以及给模型的 instructions
  mcp.rs      JSON-RPC MCP（stdio + HTTP 共用）
  server.rs   axum：预览页面、/api/*、/ws、/mcp
web/          index.html + app.js（three.js 0.170 已内嵌在 web/vendor）
```

所有编辑都在内存里用 rayon 按区块并行执行，不经过游戏服务端，也不受 tick 限制。

## 测试

```bash
cargo test --release
```

共 13 个测试，包括一个端到端测试：在小世界上依次调用每个编辑工具，验证撤销/重做、批处理、失败回滚，以及导出→导入后方块逐一对比。

## 后续可以做

- 在游戏里实时同步（Fabric 模组通过 WebSocket 接收脏区块）
- 脚本工具（在沙箱里执行 Rhai/JS），把 48 个原子工具组合成任意操作
- 水力侵蚀模拟，以及更多程序化建筑（波函数坍缩生成村庄/城堡）
- 预览改用 Minecraft 贴图（运行时从用户本机的游戏 jar 读取），加贪心网格合并
- 方块实体（箱子、告示牌）和自定义群系的数据包
