# aitothemoon

一个像真人玩家一样进入 Minecraft 服务器的 AI 私人助手：听懂你在聊天里说的话，会走路、跟随、挖方块、合成、执行指令、操作服务器菜单（指令打开的菜单和右键 NPC 打开的菜单都行）。大脑是 Claude。

它用的是**混合式 AI**：常见的指令用学会的"策略"直接做，不调用 AI；遇到新情况才问 Claude。Claude 做成功的新事情，会被自动整理成策略、审核后存进策略库，下次同类的话直接用。**用得越久，调用 AI 越少**。

**当前进度**：P0（连接 / 登录 / 重连）、P1（能听懂人话的玩家）、P2（策略库：学习 + 审核 + 复用）已完成，在本地 Paper 1.20.4 + AuthMe 测试服上 20 项端到端测试全部通过。规划见 [docs/PLAN.md](docs/PLAN.md)。

## 它能做什么

在游戏里叫它的名字（公屏）或者私聊它：

| 你说 | 它做 |
|---|---|
| `AIBot 过来` / `AIBot 跟着我` / `停` | 走到你身边 / 一直跟着你 / 立刻停下 |
| `AIBot 去 100 64 -200` | 走到坐标 |
| `AIBot 砍 10 个橡木` | 找树、挖、捡起来 |
| `AIBot 做一把木镐` | 合成，需要时自己放工作台 |
| `AIBot 打开菜单进生存服` | 执行 `/menu`，看懂菜单里每个格子，点对应按钮，多层菜单一层层点 |
| `AIBot 去找商店 NPC 买面包` | 走到 NPC 旁边右键，读菜单，点购买 |
| `AIBot 回家` | 执行 `/home` |
| `/msg AIBot 你背包里有什么` | 私聊也可以，它会私聊回复 |

做事途中你又说了话（比如"算了先别砍了"），它会停下当前动作，按你的新话调整。

### 它会自己学

第一次说"砍三个木头"时，Claude 想办法完成，然后把做法整理成一条策略（"砍{数量}个{方块}"），机器人在聊天里说"记住了「砍原木」的做法"。以后你说"帮我挖两个原木"，它直接照做，**不调用 AI**，几乎是马上开始。

- 新策略要先过审核才会入库：必须能原样重现这次成功的步骤、只用已有的工具、指令必须在允许列表里；会把物品给出去之类的高风险策略要你批准。
- 新策略先"试用"，成功 2 次后转正；总是失败会被自动停用。
- 策略失败时（比如附近没有树了），自动交给 Claude 接手，Claude 会知道"学过的做法失败了"。
- 遇到没学过的词（比如"砍三个白桦木"），当作新情况交给 Claude；学会后把新词并进原来的策略，策略库越用越宽。
- 策略库就是 `data/strategies.json`，可以直接打开看。

管理策略（直接在聊天里说，不调用 AI）：

| 你说 | 作用 |
|---|---|
| `AIBot 学会了什么` | 列出学会的策略 |
| `AIBot 不对` | 刚才用的策略做错了，忘掉它 |
| `AIBot 忘掉 3` | 忘掉 #3 策略 |
| `AIBot 批准 3` | 批准需要确认的 #3 策略 |
| `AIBot 统计` | 直接用策略完成了多少次、调用 AI 多少次 |

自动做的事（不用你说）：AuthMe 自动注册/登录、断线自动重连、饿了自动吃、快没血时躲开怪物、死亡后告诉你位置。

## 安装（Windows / macOS / Linux 都一样）

1. 安装 [Node.js 22 LTS](https://nodejs.org/)。
2. 下载代码并安装依赖：
   ```bash
   git clone https://github.com/LPPRR123/aitothemoon.git
   cd aitothemoon
   npm install
   ```
3. 复制配置文件（Windows 命令行用 `copy`，macOS/Linux 用 `cp`）：
   ```bash
   copy config.example.yaml config.yaml
   copy .env.example .env
   ```
4. 编辑 `config.yaml`：填服务器地址、`owner.names` 填你的游戏名。
5. 编辑 `.env`：填 `ANTHROPIC_API_KEY`（Claude API Key）和 `MC_PASSWORD`（机器人账号的 AuthMe 密码，第一次进服会用它自动注册）。
6. 启动：
   ```bash
   npm start
   ```
   看到 `已就绪` 就说明机器人进服并登录成功了。按 `Ctrl+C` 退出。

## 安全设计

- **只听主人的**：其他玩家的聊天、告示牌、菜单文字、NPC 说的话，都只当作信息，不会被当成指令。
- **指令三道关**：内置危险指令黑名单（`op`、`pay`、`gamemode`、`give` 等，永远不执行）→ `config.yaml` 里的允许列表 → 不在列表里的指令，只有你在聊天里亲口打出来时才执行。AI 不能自己批准自己。
- **聊天限速**：默认两句话间隔 1.5 秒、每分钟最多 20 句，防止刷屏被踢。
- **不破坏建筑**：走路时默认不挖方块、不垫方块（可在配置里打开）。
- **密码错误不死循环**：AuthMe 提示密码错误时停止重连并报错。
- 请只在自己的服务器、或者管理员同意的服务器上使用。

## 常见问题

**它听不到我说话。** 很多服务器装了聊天插件，聊天格式变了。把你在聊天里看到的一行（例如 `[VIP] Steve » 你好`）配成正则，写进 `config.yaml` 的 `chat.patterns`，例子在配置文件里。

**日志说"AuthMe 密码错误，已停止重连"。** `.env` 里的 `MC_PASSWORD` 和这个账号注册时的密码不一致。改对密码，或者让管理员在控制台执行 `authme unregister <机器人名>` 后重新注册。

**它说某个指令"不在允许列表里"。** 把指令名加到 `config.yaml` 的 `commands.allow`，或者在聊天里直接打出完整指令让它执行（例如 `AIBot 帮我执行 /warp pvp`）。

**连不上服务器 / 版本错误。** `server.version` 必须和服务器版本完全一致（例如 `1.20.4`）。正版服把 `bot.auth` 改成 `microsoft`，第一次启动会让你在浏览器里登录微软账号。

## 开发

```bash
npm test               # 单元测试（不需要服务器）
npm run typecheck      # 类型检查
npm run test-server:setup   # 在 ./test-server 准备一个本地测试服（Paper 1.20.4 + AuthMe + 测试菜单插件）
npm run smoke          # 端到端测试：需要测试服在运行，且账号 Owner 是 OP
```

测试服说明：需要 Java 17+。`npm run test-server:setup` 之后 `cd test-server && java -Xmx2G -jar paper.jar --nogui`。测试菜单插件 `TestMenus`（源码在 `tools/testmenus`）提供 `/menu` 两层箱子菜单，以及 `/spawnnpc <名字>` 生成一个右键打开菜单的 NPC。注意 AuthMe 会在玩家登录时重置 OP 状态，所以要**先登录、再在控制台 `op`**。

`npm run smoke` 不需要 API Key：它用一个按剧本出牌的假模型（`scripts/scripted-llm.ts`）代替 Claude，测试的是真实的聊天 → 决策循环 → 工具 → 游戏这条链路，以及"学会 → 不调用 AI 直接复用 → 失败交给 AI"这个学习闭环。

## 项目结构

```
src/
├─ index.ts              入口
├─ config.ts             配置（config.yaml + .env）
├─ bot/
│  ├─ BotManager.ts      连接、AuthMe 登录、断线重连
│  ├─ authme.ts          识别登录插件提示（中/英文）
│  ├─ chat.ts            聊天解析、限速发送队列
│  ├─ perception.ts      把游戏状态整理成给 AI 看的文字
│  ├─ reflexes.ts        反射：吃饭、逃跑、死亡通知
│  └─ text.ts            文字组件 / 颜色代码处理
├─ actions/              AI 能用的 18 个工具（移动、采集、合成、菜单、NPC、指令…）
├─ brain/
│  ├─ agent.ts           听主人说话 → 调 Claude → 执行工具 → 汇报
│  ├─ llm.ts             Claude API 封装
│  └─ prompts.ts         系统提示词
├─ safety/commands.ts    指令安全检查
└─ strategy/
   ├─ matcher.ts         把主人的话和策略的触发说法对上（中文数字、近义词），不调用 AI
   ├─ library.ts         策略库：存储、试用/转正/停用、统计
   └─ compiler.ts        把 Claude 的成功做法整理成策略 + 审核
scripts/                 端到端测试、测试服安装脚本
tools/testmenus/         测试用的菜单插件（源码 + jar）
docs/PLAN.md             总体规划
```
