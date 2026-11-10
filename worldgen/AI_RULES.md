# 给 AI 的规则：改地形数据包

你在帮人做一个 Minecraft Java 版 1.20.4 的世界生成数据包。你改 `worldgen/datapack/` 里的 JSON，
脚本用真实的 Paper 1.20.4 测试服把地形生成出来，导出成图和数字，你再对照目标继续改。

## 每一轮按这个顺序做

1. **先读**：
   - `worldgen/targets.yaml`：`goal`（人想要什么）、`current_stage`（现在在第几阶段）、`checks`（验收数字）
   - `worldgen/feedback.md`：人进游戏后写的反馈
   - `worldgen/log.md` 最近 10 轮
   - 上一轮的 `report.md` 和 `overview.png`（在 `worldgen/runs/` 里，最新一轮的文件夹名写在 `worldgen/runs/latest.txt`）；需要时再看剖面图 `section-*.png`
2. **先写假设再动手**：在 `worldgen/log.md` 末尾加一条，写清楚改什么、为什么、预计哪个数字往哪边变、图上哪里会变。
3. **一轮只改一件事**，只改当前阶段允许的文件（`targets.yaml` 的 `stages`）。前面阶段已经定好的东西不要动。
   要改某个原版文件时，先从 `worldgen/vanilla/` 里把它复制到 `worldgen/datapack/` 的同一路径，再改；不要凭记忆从零写。
4. **跑一轮**：`npm run worldgen:round`。大约一两分钟。
   退出码 0 = 检查全过；1 = 跑完了但有检查没过；2 = 没跑成（数据包有错、改了不该改的文件、或者该人工把关了），原因会打印出来，也在 `report.md` 里。
5. **对照假设看结果**：预计的变化发生了吗？有没有意外的副作用（看 `diff-height.png` 和报告里的"变化"列）？把实际结果补进 `log.md` 那一条。
6. **变差了就撤回**这次改动，在 `log.md` 记下"这条路不行"和原因，换一个思路。上一轮的数据包在 `worldgen/runs/<上一轮>/datapack/`。
7. 当前阶段的检查全部通过后，跑 `npm run worldgen:verify`（换 3 个种子）。所有种子都通过，这个阶段才算完成。
   然后**停下来告诉人**，由人决定要不要把 `current_stage` 加 1。

## 不能做的事

- **不能改** `worldgen/targets.yaml`、`worldgen/feedback.md`、`worldgen/rounds.jsonl`、`scripts/worldgen/`、`tools/wgexport/`。数字不达标只能改数据包；觉得某条标准不合理，就告诉人，让人来改。
- **不能只盯着数字**。数字是底线，不是目标。`goal` 里写的感觉和 `feedback.md` 里人说的话，比"再多 2% 平地"重要。如果一个改动让数字达标了但地形变得单调（比如把山削平、把海岸拉直），不要保留它，在 `log.md` 里写明原因。
- **不能用 `--force`** 绕过"该人工把关了"或者阶段检查。脚本拒绝运行时，停下来，把原因和报告里"值得进游戏看的地方"告诉人。
- 一个种子好看不算数，定稿前必须换种子验证。
- `feedback.md` 里写了"参考轮"的话，每轮都要和那一轮的 `overview.png` 对比，别越改越偏。

## 需要知道的事

- **结果有很小的随机波动**。同一个数据包、同一个种子跑两次，地形和群系一样，但树、花草这类装饰的位置会有少量不同（Minecraft 多线程生成时装饰的先后顺序不固定）。所以占比类的数字差 0.1 个百分点以内，当作没变。
- 村庄之类的建筑也算在地面高度里，会在坡度图上显示成一小块一小块的"悬崖"。
- 数据包写错时，1.20.4 的服务端会整个拒绝加载，不会悄悄退回原版。报错原文在 `report.md` 里，最有用的是 `Failed to parse ... .json` 和它下面的 `Caused by:` 那一行。
- JSON 里不能有注释，不能有多余的逗号。`pack.mcmeta` 的 `pack_format` 必须是 26。
- 所有指标的名字和定义见 `docs/WORLDGEN-LOOP.md` 第 5.2 节；任何一轮的 `metrics.json` 里有全部数字。

## 1.20.4 世界生成的文件在哪

| 想改什么 | 文件（都在 `data/minecraft/` 下面） |
|---|---|
| 海平面、地下含水层、地表方块规则（`surface_rule`）、噪声路由 | `worldgen/noise_settings/overworld.json` |
| 大陆度、侵蚀度、山脊、地形高低起伏（`offset` / `factor` / `jaggedness` 的样条） | `worldgen/density_function/overworld/*.json` |
| 各种噪声的频率和振幅 | `worldgen/noise/*.json` |
| 群系分布（哪种气候参数出哪个群系） | `dimension/overworld.json`：`biome_source` 里写明每个群系的参数。原版的完整参数表在 `worldgen/vanilla/reports/biome_parameters/minecraft/overworld.json`；原版的维度结构在 `worldgen/vanilla/data/minecraft/worldgen/world_preset/normal.json` |
| 单个群系的颜色、降水、生物、装饰列表 | `worldgen/biome/<名字>.json` |
| 树、矿、花草等装饰 | `worldgen/configured_feature/`、`worldgen/placed_feature/` |

自定义的新群系、新装饰放在 `data/aitothemoon/` 下面。新群系如果是海洋或河流，记得加进
`data/minecraft/tags/worldgen/biome/is_ocean.json`（或 `is_river.json`），否则海洋占比算不到它。
