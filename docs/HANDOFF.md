# aitothemoon 交接文档

> 更新：2026-11-11。这份文档总结了到目前为止的全部工作，给新的会话 / 新的项目接手用。
> 代码在 GitHub 仓库 `LPPRR123/aitothemoon` 的分支 **`claude/minecraft-ai-player-bot-stp6zh`**（最新提交 `a18b748` 之后的这一次）。这个仓库没有 main 分支，也还没开 PR。
> 详细设计见 [`docs/PLAN.md`](PLAN.md)，使用说明见 [`README.md`](../README.md)。

---

## 1. 这是什么

一个像真人玩家一样进入 Minecraft Java 服务器的 **AI 私人助手**（Node.js + TypeScript + Mineflayer，大脑是 Claude）：
听懂主人在聊天里说的话，走路、跟随、挖方块、合成、熔炼、箱子存取、放方块、打怪、睡觉、村民交易、执行指令、操作服务器菜单（指令打开的和右键 NPC 打开的都行），有长期记忆和提醒，而且**越用越少调用 AI**。

机器人是一个单独的游戏账号：直接读游戏数据，不看截图，不碰主人的鼠标。

## 2. 已确认的决定

| 项目 | 决定 |
|---|---|
| 服务器 | Java 版 **1.20.4**，离线服 + **AuthMe** 登录插件 |
| 大模型 | **Claude**，默认 `claude-opus-5-5`，effort=low；开了服务器端拒答后备（`fallbacks: "default"`） |
| 运行位置 | 主人自己的电脑（Windows），`npm start` |
| 定位 | 只听主人一个人的私人助手；其他玩家的话只当信息 |
| 菜单 | 两种都支持：指令打开（如 `/menu`）和右键 NPC 打开 |
| 核心原则 | **混合式 AI（Hybrid AI）**：常见情况用学会的策略/固定逻辑处理（目标 80%–95%），只有新情况才调用 Claude；新策略经代码审核后存库复用 |

"混合式 AI"这个方向来自主人和 ChatGPT 在 2026-09-14 的讨论（不是某个现成开源项目）：识别新情况 → AI 生成策略 → 权限检查/规则验证 → 存库 → 下次直接复用、不调用 AI；另外要有长期记忆（真实世界状态、自己的认知、错误认知、遗忘、行为一致性）。

## 3. 已经完成的（全部推送）

| 阶段 | 内容 |
|---|---|
| P0 地基 | 配置（`config.yaml` + `.env`）、连接、AuthMe 自动注册/登录（中英文提示）、断线指数退避重连、密码错误时停止重连 |
| P1 能听懂人话 | Claude 工具调用循环；"停"立即生效；做事途中主人说新话会打断当前动作；聊天限速；指令三道关（内置黑名单 → 允许列表 → 主人亲口打出的才执行）；反射（饿了吃、快没血躲怪、死亡通知） |
| P2 策略库 | Claude 做成的新事 → 整理成策略（触发说法 + 参数 + 步骤）→ **代码审核**（必须原样重现成功步骤、工具存在、指令合规、高风险要主人批准）→ 试用 2 次成功转正、失败多了停用 → 同类指令直接重放、**零 AI 调用**；中文数字、客套词、近义词表；策略合并 |
| P2 环境检查（参考 muscle-mem） | 学的时候代码记下：每步前后的菜单标题、维度、有没有传送、手持物品、背包多了什么；重放时逐步核对。每个工具有**预检**（附近有没有方块/NPC/箱子/床、材料够不够…）：还没动手就不满足 = 新情况，不扣策略分 |
| P3 长期记忆 | 认知（地点/事实/偏好/规矩）带来源、置信度、验证/矛盾次数、修改历史；矛盾两次 = "可能是错的"；保留分（重要度 × 新近度 × 使用 × 置信度）低的自动归档；主人的规矩和偏好每次都放进提示词；"记住这里是X / 去X / 你记得哪些地方 / 忘掉X" 不调用 AI |
| P3.5 记忆进阶 | 提醒（"5分钟后/明天早上/天黑了/每天晚上 提醒我…"，代码解析；主人不在线就等）；代码自动记服务器知识（菜单的所有打开方式和按钮、右键过的 NPC、指令回复）；黑话由 Claude 理解后记；记忆目录 + 模糊找地点 |
| P3.6 生存动作（参考 Mindcraft，MIT） | 熔炼、箱子存取/查看、放方块（不挖已有方块）、打生物（不打玩家和村民）、睡觉、村民交易、吃东西；箱子策略记住是哪个箱子 |

规模：**33 个工具**，**66 个单元测试**，**47 项端到端测试**（本地 Paper 1.20.4 + AuthMe 测试服上全部通过）。

### 在聊天里能直接用的指令（都不调用 AI）

`停` · `学会了什么` · `不对`（忘掉刚用的策略）· `忘掉 3` · `批准 3` · `统计` · `记住这里是基地` · `去基地` · `你记得哪些地方` · `你记得什么` · `忘掉基地` · `5分钟后提醒我…` · `天黑了提醒我…` · `有哪些提醒` · `取消提醒 2`

## 4. 代码地图

```
src/index.ts              入口（创建 BotManager、Agent、策略库、记忆库）
src/config.ts             配置 schema（zod）
src/bot/                  连接/登录/重连、聊天解析与限速、感知、反射、文字组件处理
src/brain/agent.ts        核心：主人消息 → 管理指令 / 记忆指令 → 学过的策略 → 记得的地点 → Claude；
                          学习、环境检查、服务器知识记录、提醒检查都在这里
src/brain/llm.ts          Claude 调用封装（beta messages + fallbacks）
src/brain/prompts.ts      系统提示词（保持不变以命中缓存）+ 任务提示词
src/actions/              33 个工具：movement / gather / interact / inventory / chat / survival / memory
src/strategy/             matcher（触发说法匹配）、library（策略库）、compiler（整理 + 审核）、checks（环境检查）
src/memory/               store（认知、事件、提醒、遗忘、提示词里的记忆）、reminders（提醒说法解析）
src/safety/commands.ts    指令安全检查
scripts/smoke.ts          端到端测试（两个机器人 + 按剧本出牌的假模型 ScriptedLlm）
scripts/setup-test-server.ts  一键准备本地测试服（Paper 1.20.4 + AuthMe + TestMenus）
tools/testmenus/          测试插件：/menu 两层菜单、/spawnnpc、/menutitle、/home、/testcooldown
data/                     运行时生成：strategies.json、memory.json（不进仓库）
```

## 5. 怎么运行 / 测试

```bash
npm install
cp config.example.yaml config.yaml   # 填服务器地址、owner.names
cp .env.example .env                 # 填 ANTHROPIC_API_KEY、MC_PASSWORD
npm start

npm test                     # 单元测试
npm run typecheck
npm run test-server:setup    # 本地测试服（需要 Java 17+），然后 cd test-server && java -Xmx2G -jar paper.jar --nogui
npm run smoke                # 端到端测试：测试服在跑、账号 Owner 是 OP（先登录再在控制台 op Owner）
```

## 6. 还没做 / 没验证的

- **真实 Claude 从没跑过**（云端环境没有主人的 API Key）。所有测试用的是 `ScriptedLlm`。第一件事：在主人电脑上 `npm start`，看 Claude 选工具、整理策略、用记忆的实际表现，日志里"这次没有学成策略：…"的原因要收集起来调提示词。
- "要在主城附近才执行"这类地点条件；白天/夜晚检查（目前没有动作依赖它，故意没加）。
- 承诺之外的主动行为（空闲时自己找事学）、多机器人协作、视觉、网页控制台（PLAN 路线图 P4/P5）。

## 7. 踩过的坑（Mineflayer 1.20.4 + Paper）

- `bot.craft(recipe, n)` 多次合成会丢：改成一次一个、等服务器确认。
- 工作台/箱子窗口一打开就点会和服务器的窗口内容包赛跑 → 先等 300–500ms 再点（工作台合成是自己实现的）。
- 1.20.3+ 的踢出原因、物品名是 NBT 格式，要先转换。
- AuthMe 会在玩家登录时重置 OP（测试服要先登录再 `op`）。
- 村民交易只有一种材料时，`inputItem2` 是个空壳对象，要看 `hasItem2`。
- 传送要靠 `forcedMove` 事件识别，不能只看移动距离（走过去也会移动）。
- 在云端沙箱里 Node 的 `fetch` 要 `NODE_USE_ENV_PROXY=1` 才走代理（主人电脑上不需要）。

## 8. 进行中的任务：用机器人测试 FKFriends 好友插件

**状态：还没拿到插件代码。**
- 插件在私有仓库 `LPPRR123/AI_workspace`（本地路径 `E:\git\AI_workspace\source_codes`），本会话的 GitHub 权限覆盖不到，电脑上的文件夹也没有共享给云端会话（Windows 上的 Claude 桌面应用可能需要更新）。
- 解决办法（任选）：在 https://claude.ai/connect-github 给 Claude 开放 `AI_workspace`；或者在电脑本地开 Claude Code 会话直接读；或者把源码/jar 传进某个能访问的仓库。

**拿到之后的计划：**
1. 读 `plugin.yml`（指令、权限）和源码：好友请求/同意/删除/存储怎么实现，依赖什么（MySQL、Vault、PlaceholderAPI…），是游戏服插件还是 BungeeCord/Velocity 代理插件（代理插件要多搭一个代理服）。先给一份插件说明 + 测试计划。
2. 在本地 Paper 1.20.4 + AuthMe 测试服上装插件，用这个项目的机器人框架上线 Alice、Bob、Carol 三个玩家，写一个确定性的测试脚本（参考 `scripts/smoke.ts` 的写法：`say()`、`check()`、`op()`、读聊天回复、读菜单 `describeWindow`、按名字点按钮 `click_slot {name}`）。
3. 测试范围：
   - 基本流程：发请求、对方收到通知、同意 / 拒绝、好友列表、删除后双方同步。
   - 边界：加自己、加不存在的玩家、重复请求、已经是好友再加、同时互加、名字大小写、好友上限、对方不在线。
   - 数据保存：下线再上线、重启服务器后关系还在。
   - 菜单（如果有）：每个按钮的结果。
   - **全程盯服务器日志**，插件抛出的 Java 异常要记下是哪一步触发的、完整堆栈。
   - 可选：让 AI 机器人"乱试"，找人工想不到的问题。
4. 输出：测试报告（每项通过/失败 + 具体回复 + 抓到的异常），测试脚本留在仓库里可重跑。

## 9. 参考过的项目

- **muscle-mem**（pig-dot-dev）：AI Agent 行为缓存 + 环境检查（Check）—— 我们的策略库和环境检查参考了它。
- **Mindcraft**（mindcraft-bots，MIT）：Mineflayer + 多种大模型，40 个动作；我们的生存动作参考了它（见 `THIRD_PARTY_NOTICES.md`）。它没有"学会后不调用 AI"的机制，也不会操作插件菜单和 AuthMe。
- **MaiBot（麦麦）**：表达方式/黑话学习，规则过滤 + AI 审核 + 计数门槛。
- **Voyager**、**Agent Skill Induction**、**Agentic Plan Caching**、**Agent Workflow Memory**：技能库 / 计划缓存相关论文。

---

## 给新会话的开场白（复制粘贴即可）

> 我有一个 Minecraft AI 机器人项目 aitothemoon（GitHub：LPPRR123/aitothemoon，分支 claude/minecraft-ai-player-bot-stp6zh）。请先读 `docs/HANDOFF.md`，了解已经做了什么、怎么运行、还剩什么。接下来我想用这个机器人框架测试我的好友插件 FKFriends（源码在 `E:\git\AI_workspace\source_codes`）：先读插件代码，告诉我它有哪些指令和功能、依赖什么，再按 HANDOFF 第 8 节的计划写测试脚本、在 Paper 1.20.4 + AuthMe 测试服上用多个机器人实测，给我一份测试报告。
