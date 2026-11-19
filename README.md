# dsh-team-model-router

在 DSH（DeepSeek Harness）Agent Team 里，**同一个对话、下一个任务换一个模型**——不用重建成员、不用解散团队。也可以不走模型：用 `/team-model` 斜杠指令或设置卡片直接改。

同时保留另一层能力：给成员设**默认路由**（创建时生效）。

> 核心不是"重新 spawn"，而是宿主导出的 `installModelSelection(agentCtx, ref)`：活着的 Agent 有一个可变的模型选择，**下一轮 prompt 组装时读它**。插件只在成员的 `turn/start` 设值、在 `turn/end` 还原。

---

## 1. 你要的场景：下一个任务换模型

对话里正常协作，队长在派活前调用：

```
team_next_model(member="coder", provider="deepseek", model="deepseek-v4")
```

然后照常给 coder 发任务。**这个任务**用 `deepseek/deepseek-v4` 跑；任务结束（`turn/end`）自动回到 coder 自己的原路由，下一单继续用原模型。

要连续几个任务都用新模型：

```
team_next_model(member="coder", provider="qwen", model="qwen3-coder", scope="sticky")
```

不想用了：

```
team_next_model_clear(member="coder")
```

### 时序规则（关键，已做成状态机并测试）

| 调用时机 | 行为 |
| --- | --- |
| 成员空闲 | 下一个 `turn/start` 生效 |
| 成员正在跑任务 | **当前任务不受影响**，排队到它的下一轮 |
| 成员不活跃（cold） | 按成员名排队，冷恢复（`agent/created`）后第一个任务生效 |
| `scope=next-turn` | 该轮 `turn/end` 自动还原成成员自己的路由 |
| `scope=sticky` | 一直保留，直到 `team_next_model_clear` |

## 2. Web 界面：会话内指令 + 设置卡片

不用让模型去调工具，两个人类入口都直接落在 UI 上。

### 2.1 斜杠指令 `/team-model`（会话内）

在输入框直接敲：

| 输入 | 作用 |
| --- | --- |
| `/team-model` | 队长路由、成员默认路由、每个成员的 override |
| `/team-model coder deepseek deepseek-v4` | coder 的**下一个任务**用这个模型，一轮后自动还原 |
| `/team-model coder sticky qwen qwen3-coder` | 一直用，直到 clear |
| `/team-model coder effort=high deepseek deepseek-v4` | 同时指定 reasoning effort |
| `/team-model coder clear` | 取消临时模型 |
| `/team-model default coder qwen qwen3-coder` | 写成员默认路由（重建成员生效） |
| `/team-model default all clear` | 清空默认路由 |

指令通过 `ctx.commands.register()` 注册，**由 UI 适配器直接渲染返回文本，不进入模型历史、不消耗 token**，模型不会因为这条指令被唤醒。

### 2.2 设置卡片（设置页）

插件注册 `team-model-router` 命名空间，schema 就是长期配置：

```yaml
defaults: { provider: deepseek, model: deepseek-v4 }   # 可选
members:
  coder: { provider: qwen, model: qwen3-coder }
```

设置页按 schema 渲染成一张卡片，字段语义与 `team_model_set` 完全同源，`applies: live` 即时生效；改动通过 `watch` 回写到内存路由。旧版写在 `rules.json` 里的规则，首次启动会自动导入设置卡片，不会丢。

限制：卡片的控件样式由宿主配置界面决定（对象/字典可能渲染成表单，也可能渲染成 JSON 编辑器），插件不控制外观；会话内指令只接受文本参数，没有下拉框——`dsh-commands` 的公开契约里明确把表单和补全留给命令实现方。


## 3. 两层路由，别混

| 层 | 工具 | 生效范围 | 是否需要重建成员 |
| --- | --- | --- | --- |
| 成员默认路由 | `team_model_set` | 该成员**以后每次**创建/唤醒 | 是（默认路由写进创建快照） |
| 下一个任务路由 | `team_next_model` | **仅下一轮**（或 sticky） | 否，活着的 Agent 直接换 |

`team_model_list` 会同时显示两种状态：

```
- coder [idle] observed=qwen/qwen3-coder expected=qwen/qwen3-coder source=rule:coder match override=deepseek/deepseek-v4 (next-turn, queued)
- reviewer [idle] observed=deepseek/deepseek-v3 expected=deepseek/deepseek-v4 source=inherit STALE
```

`override=...` 是下一单的临时模型；`STALE` 是创建快照过期（默认路由层面），两者互不影响。

## 4. 安装

```bash
# 本地目录
dsh plugin --profile web add /absolute/path/to/dsh-team-model-router

# 本地 tarball
dsh plugin --profile web add /absolute/path/to/dsh-team-model-router-0.3.0.tgz

# GitHub / npm
dsh plugin --profile web add github:<owner>/dsh-team-model-router
dsh plugin --profile web add dsh-team-model-router
```

重启 dsh。纯 ESM JS、无构建步骤，不会触发 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。

规则文件：`$DSH_HOME/team-model-router/rules.json`（默认 `~/.dsh/team-model-router/rules.json`）。

## 5. 配置

```yaml
- id: team-model-router
  name: dsh-team-model-router
  config:
    defaultProvider: deepseek
    defaultModel: deepseek-v4
    members:
      coder: { provider: qwen, model: qwen3-coder }
      reviewer: { provider: deepseek, model: deepseek-v4 }
```

配置只是默认路由的基线；不配置也能用 `team_next_model`（下一单临时换模型不依赖规则文件）。

## 6. 工具

### `team_next_model`（核心）

```
team_next_model(
  member="coder",
  provider="deepseek",
  model="deepseek-v4",
  reasoning_effort="high",   # 可选
  scope="next-turn"          # 或 "sticky"
)
```

- `provider` + `model` 必须成对；裸 model 会被拒绝（宿主本来就会忽略）。
- `reasoning_effort` **支持**：`ModelSelection` 带 effort，会随该任务一起生效。

### `team_next_model_clear`

取消排队/粘滞的临时路由，并把成员还原成自己的路由。

### `team_model_set` / `team_model_clear` / `team_model_list` / `team_model_reload`

成员默认路由的增删查、手改 JSON 后重载。

所有写操作仅 Team Lead 可调用；普通成员调用会被拒绝。

## 7. 队长提示词（可直接加进 AGENTS.md）

```
【团队模型调度】
1. 用户说“这单用小模型/换个模型/下一个任务用 X”，调用 team_next_model，不要重建成员，也不要解散团队。
2. 该成员正在跑任务时，team_next_model 会自动排到它的下一轮；不要为了“立刻生效”去打断它。
3. 只影响一个任务就用默认 scope=next-turn；说“以后都用”才用 sticky。
4. 切完模型照常派活；任务结束后不需要手动还原（next-turn 自动还原）。
5. 改成员默认路由才用 team_model_set，并说明需要重建成员才生效。
6. 不确定当前状态时先调 team_model_list，看 override 与 STALE。
```

## 8. 原理与代码

```
index.js            插件入口：两层路由接线、6 个工具、/team-model 指令、设置卡片
lib/command.js      `/team-model` 指令语法与用法文本
lib/overrides.js    每任务切换的纯状态机（turn/start 设值、turn/end 还原、mid-turn 排队）
lib/pending.js      spawnTeammate → startContinuable 的一次性交棒（默认路由层）
lib/patch.js        startContinuable / start / spawnTeammate 的可逆包裹
lib/rules.js        路由校验、通配匹配、优先级、STALE 判定
lib/store.js        $DSH_HOME 原子读写
test/               31 个 node:test 用例
```

下一单换模型走的是：

```js
import { installModelSelection } from '@deepseek-ai/dsh-agent'
const ref = { current: undefined, assembled: undefined }
installModelSelection(agent.ctx, ref)                 // 装在成员自己的 Agent ctx 上
ref.current = { provider, model, reasoningEffort }    // turn/start
ref.current = undefined                               // turn/end
```

`installModelSelection` 内部在 `system-prompt/assemble` 快照 `current`，再在 `agent/request` 用快照覆盖 provider/model/effort —— 所以切换只影响**之后的组装**，不会劈叉到正在跑的请求。

## 9. 验证

```bash
npm test        # 31 passed
```

覆盖：斜杠指令语法、next-turn 生效/还原、mid-turn 排队不改当前任务、sticky 保留、冷恢复交接、成员隔离、路由成对校验、通配匹配、文件原子读写。

另外做过一次桩集成冒烟（`installModelSelection` + `session/event` + `agent/created` 全部打桩）：6 个工具注册、turn/start 设值、turn/end 还原、running 排队、inactive 冷恢复、roster 显示 override、非 Lead 拒绝，全部通过。

## 10. 限制（诚实版）

1. **不能改"当前正在跑"的那一轮**。宿主的组装是快照式的；插件能做的是排到下一轮，不会中途劈开模型。
2. **跨会话不持久**：`sticky` 只活在这个进程里；成员/会话结束就没了。要长期固定请用 `team_model_set`（默认路由）。
3. 依赖 `@deepseek-ai/dsh-agent` 导出 `installModelSelection`。旧版本没有该导出时，下一单切换会明确报错，不会静默失效。
4. `agent.ctx` 上再装一个 selection 监听器会与宿主自带的 `/model` 切换叠加；本插件后注册，会在自己持有的 ref 上覆盖 provider/model。两者同时用时要清楚谁最后生效。
5. 成员名匹配来自 `agentTeams.listMembers`；团队服务不可用时只保留排队逻辑，无法确认成员是否存在。
6. **没有图形化下拉选择器**：`dsh-commands` 只提供非结构化文本输入，表单/补全属于命令实现方；插件给的是语法清晰的文本指令，不是弹窗。
7. **命令与卡片依赖宿主服务**：Web 客户端有命令适配器；headless / ACP 组合可能不挂 `commands`，此时斜杠指令自动缺席，卡片也取决于是否挂载 `settings` 提供方（都没有时退回 `rules.json`）。

## 11. 复用来源

- **每任务切换**：`@deepseek-ai/dsh-agent` 的 `installModelSelection` / `ModelSelectionRef`（已发布 `.d.ts` 与 `lib/index.js` 实现）
- **回合边界**：`@deepseek-ai/dsh-session` 的 `turn/start` / `turn/end` 事件
- **包裹与还原**：`NanmiCoder/dsh-agent-teams` 的 `guardSubagentCreation`（`harness-compat.js`）
- **默认路由注入**：`@deepseek-ai/dsh-subagent` 的 `ContinuableStartSpec.request.agentOptions`
- **会话内指令**：`@deepseek-ai/dsh-commands` 的 `ctx.commands.register`
- **设置卡片**：`@deepseek-ai/dsh-settings` 的 `ctx.settings.register` / `describe`
- 工具/配置写法：官方 `defineTool` + `schemastery`

MIT License.
