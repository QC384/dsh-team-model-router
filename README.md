# dsh-team-model-router

在 DSH（DeepSeek Harness）Agent Team 里，**同一个对话、下一个任务换一个模型**——不用重建成员、不用解散团队。

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

## 2. 两层路由，别混

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

## 3. 安装

```bash
# 本地目录
dsh plugin --profile web add /absolute/path/to/dsh-team-model-router

# 本地 tarball
dsh plugin --profile web add /absolute/path/to/dsh-team-model-router-0.2.0.tgz

# GitHub / npm
dsh plugin --profile web add github:<owner>/dsh-team-model-router
dsh plugin --profile web add dsh-team-model-router
```

重启 dsh。纯 ESM JS、无构建步骤，不会触发 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。

规则文件：`$DSH_HOME/team-model-router/rules.json`（默认 `~/.dsh/team-model-router/rules.json`）。

## 4. 配置

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

## 5. 工具

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

## 6. 队长提示词（可直接加进 AGENTS.md）

```
【团队模型调度】
1. 用户说“这单用小模型/换个模型/下一个任务用 X”，调用 team_next_model，不要重建成员，也不要解散团队。
2. 该成员正在跑任务时，team_next_model 会自动排到它的下一轮；不要为了“立刻生效”去打断它。
3. 只影响一个任务就用默认 scope=next-turn；说“以后都用”才用 sticky。
4. 切完模型照常派活；任务结束后不需要手动还原（next-turn 自动还原）。
5. 改成员默认路由才用 team_model_set，并说明需要重建成员才生效。
6. 不确定当前状态时先调 team_model_list，看 override 与 STALE。
```

## 7. 原理与代码

```
index.js            插件入口：两层路由接线、6 个工具
lib/overrides.js    每任务切换的纯状态机（turn/start 设值、turn/end 还原、mid-turn 排队）
lib/pending.js      spawnTeammate → startContinuable 的一次性交棒（默认路由层）
lib/patch.js        startContinuable / start / spawnTeammate 的可逆包裹
lib/rules.js        路由校验、通配匹配、优先级、STALE 判定
lib/store.js        $DSH_HOME 原子读写
test/               23 个 node:test 用例
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

## 8. 验证

```bash
npm test        # 23 passed
```

覆盖：next-turn 生效/还原、mid-turn 排队不改当前任务、sticky 保留、冷恢复交接、成员隔离、路由成对校验、`*` / `?` 通配匹配、文件原子读写。

另外做过一次桩集成冒烟（`installModelSelection` + `session/event` + `agent/created` 全部打桩）：6 个工具注册、turn/start 设值、turn/end 还原、running 排队、inactive 冷恢复、roster 显示 override、非 Lead 拒绝，全部通过。

## 9. 限制（诚实版）

1. **不能改"当前正在跑"的那一轮**。宿主的组装是快照式的；插件能做的是排到下一轮，不会中途劈开模型。
2. **跨会话不持久**：`sticky` 只活在这个进程里；成员/会话结束就没了。要长期固定请用 `team_model_set`（默认路由）。
3. 依赖 `@deepseek-ai/dsh-agent` 导出 `installModelSelection`。旧版本没有该导出时，下一单切换会明确报错，不会静默失效。
4. `agent.ctx` 上再装一个 selection 监听器会与宿主自带的 `/model` 切换叠加；本插件后注册，会在自己持有的 ref 上覆盖 provider/model。两者同时用时要清楚谁最后生效。
5. 成员名匹配来自 `agentTeams.listMembers`；团队服务不可用时只保留排队逻辑，无法确认成员是否存在。

## 10. 复用来源

- **每任务切换**：`@deepseek-ai/dsh-agent` 的 `installModelSelection` / `ModelSelectionRef`（已发布 `.d.ts` 与 `lib/index.js` 实现）
- **回合边界**：`@deepseek-ai/dsh-session` 的 `turn/start` / `turn/end` 事件
- **包裹与还原**：`NanmiCoder/dsh-agent-teams` 的 `guardSubagentCreation`（`harness-compat.js`）
- **默认路由注入**：`@deepseek-ai/dsh-subagent` 的 `ContinuableStartSpec.request.agentOptions`
- 工具/配置写法：官方 `defineTool` + `schemastery`

MIT License.
