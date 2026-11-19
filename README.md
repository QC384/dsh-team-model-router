# dsh-team-model-router

给 DSH（DeepSeek Harness）Agent Team 做模型路由的插件：**同一个对话里，把某个队员的下一个任务的模型换掉，不用重建成员**。默认路由、成员自定义模型、Web 侧斜杠指令与设置卡片都在这里。

```bash
dsh plugin add dsh-team-model-router
```

- 包名 `dsh-team-model-router`，`type: module`，`engines.node >= 22`
- 通过 `dsh.bundle.patch`（`cordis.patch.yml`）挂载，无需手改宿主配置
- 全部功能只走宿主真实导出的接口，不伪造能力

## 1. 三条入口，一个核心

| 入口 | 谁用 | 作用 |
| --- | --- | --- |
| 工具 `team_next_model` / `team_model_set` / `team_next_model_clear` / `team_model_clear` / `team_model_list` / `team_model_reload` | 队长（模型侧） | 让模型自己调用，改下一个任务或成员默认路由 |
| 斜杠指令 `/team-model` | 人（Web/CLI） | 不经过模型、不耗 token，直接写路由 |
| 设置命名空间 `team-model-router` | 人（配置界面） | 卡片式编辑 defaults / members / aliases / fallback |

三者操作同一份路由状态，谁改都会同步到其余两处。

## 2. 两种“换模型”语义

1. **成员默认路由**（`team_model_set`、`/team-model default`）
   决定成员**创建时**用什么模型。宿主 `spawn_teammate` 本身不带 model，插件把路由从 `agentTeams.spawnTeammate` 交到 `ctx.subagents.startContinuable` 的 `agentOptions`（`{provider, model}` 必须成对）。
   *已存在的成员不会自动变*——它们创建时已快照了路由，必须释放后重建（roster 里标 `STALE` 就是这种）。

2. **下一个任务路由**（`team_next_model`、`/team-model <成员> ...`）
   用宿主导出的 `installModelSelection(agentCtx, ref)` 装一个可变选择 ref：prompt 组装读 `ref.current`，`agent/request` 用 `ref.assembled` 覆盖 provider/model/reasoningEffort。因此**不重建成员也能换下一轮模型**。
   - `scope=next-turn`：只吃一轮，该轮 `turn/end` 立刻还原
   - `scope=sticky`：一直生效，直到 `team_next_model_clear`
   - 成员正在跑：排到它的**下一轮**，绝不改写正在飞的那一轮（宿主快照边界）

## 3. v0.4.0 增强

### 3.1 会话级持久化（跨刷新/重启）

插件自建 `$DSH_HOME/team-model-router/sessions.json`：键是**对话会话 id + 成员名**。

- 为什么不用 session meta：`SessionHeader.meta` 只有 `cwd/parentSession/createdAt/seedLength/origin/delegationDepth/agentPreset`，没有任意扩展位，写不进去。
- 为什么按“成员名”：会话重启后 Agent id 会重新生成，但 `session.meta.parentSession` 稳定，`agent/created` 时用它 + 成员名找回 override。
- `next-turn` 的条目在该轮 `turn/end` 后删除；`sticky` 保留到手动清除。
- 文件损坏/字段缺失只报一条诊断，不会中断插件。

### 3.2 模型目录与校验

`lib/catalog.js` 只读 `ctx.get('llm')`：

- `listProviders()` / `listModels(provider)` / `describe()` 给 `/team-model models` 列表
- `verify(route)` 分四种结果：
  - `ok`
  - `unknown-provider` —— **硬失败**，provider 没注册，请求必挂
  - `unlisted-model` —— **仅提示**，目录是 advisory，没列出的 model id 仍可能可用
  - `unavailable` —— llm 服务未挂载或目录异常，放行但不校验
- 目录结果缓存 60s

### 3.3 别名

设置卡片或 config 里配 `aliases`，`/team-model coder v4` 就能用：

```json
{ "aliases": { "v4": "deepseek/deepseek-v4", "coder": { "provider": "qwen", "model": "qwen3-coder" } } }
```

也直接支持 `provider/model` 简写。非法别名/缺字段会在 `aliases` 列表里给出诊断，绝不静默接受。

### 3.4 审计

每次路由变更写 `$DSH_HOME/team-model-router/audit.jsonl`（一行一条 JSON：`at/action/member/session/actor/from/to/scope/note`）。
`/team-model log [n]` 看最近 n 条（默认 20，上限 200）。写失败只报一次诊断，**绝不让日志拖垮路由**。

### 3.5 health

`/team-model health` 一次性检查：settings 命名空间、command plane、llm 服务、agent teams、`installModelSelection` 是否可用、别名、fallback、持久化条数与文件、审计文件、stale 成员、全部诊断。

### 3.6 CONFLICT 标记

roster 里同时存在“成员规则”和“下一个任务 override”且两者不一致时，显式标注：

```
- coder [idle] observed=deepseek/deepseek-v4 expected=qwen/qwen3-coder source=rule:coder ok
  override=deepseek/deepseek-v4 (next-turn, queued)
  CONFLICT: override deepseek/deepseek-v4 wins over rule:coder
```

override 优先级 > 成员规则 > 默认路由 > 队长路由，冲突必须让人看见。

### 3.7 provider 降级

`unknown-provider` 且配置了 fallback 时，替换成 fallback 路由并在结果/审计里注明：

```json
{ "fallbackProvider": "deepseek", "fallbackModel": "deepseek-v4" }
```

没配 fallback 就明确报错，不猜。

## 4. 斜杠指令语法

```
/team-model                                    查看路由与 override
/team-model models [provider]                  宿主注册的模型目录
/team-model aliases                            已配置别名
/team-model log [n]                            最近 n 条审计
/team-model health                             各服务挂载与持久化状态
/team-model coder deepseek deepseek-v4         下一任务换模型（一轮）
/team-model coder v4                           别名 / provider/model 简写
/team-model coder sticky qwen qwen3-coder      持续生效
/team-model coder effort=high deepseek deepseek-v4
/team-model coder clear                        取消下一任务 override
/team-model default coder qwen qwen3-coder     成员默认路由（需重建生效）
/team-model default all clear                  清空全部默认路由
```

## 5. 工具清单（队长可用）

| 工具 | 说明 |
| --- | --- |
| `team_next_model` | 给某成员的**下一个任务**换 provider/model（`scope: next-turn \| sticky`，可选 `reasoning_effort`） |
| `team_next_model_clear` | 撤掉 override，立即恢复成员自己的路由 |
| `team_model_set` | 成员默认路由（`"*"` 表示未列出成员的默认） |
| `team_model_clear` | 清成员规则 / `"*"` / `"all"` |
| `team_model_list` | 队长路由、成员规则、每个成员实际路由、override、STALE、CONFLICT |
| `team_model_reload` | 手改文件后重读 |

全部工具仅 Team Lead 可调（`tryMembership` 不是 lead 直接拒绝）。

## 6. 配置示例

```yml
plugins:
  dsh-team-model-router:
    rulesFile: ~/.dsh/team-model-router/rules.json
    defaultProvider: deepseek
    defaultModel: deepseek-v4
    fallbackProvider: deepseek
    fallbackModel: deepseek-v4
    aliases:
      v4: deepseek/deepseek-v4
    members:
      coder:
        provider: qwen
        model: qwen3-coder
```

有 settings 服务时，卡片里的值是权威来源，`rules.json` 只在首次启动时导入一次；没有 settings 时才回落到文件。

## 7. 状态文件

| 文件 | 内容 |
| --- | --- |
| `rules.json`（或自定义 `rulesFile`） | 默认路由 + 成员规则（无 settings 时） |
| `sessions.json` | 会话级 override（键：会话 id + 成员名） |
| `audit.jsonl` | 路由变更审计 |

三者都在 `$DSH_HOME`（默认 `~/.dsh`）下，原子写（临时文件 + rename），不会写出半截 JSON。

## 8. 测试

```bash
npm test        # node --test test/*.test.mjs
```

45 个用例，覆盖路由规则、patch、override 状态机、命令语法、别名、目录校验、会话存储与审计。全部不依赖真实宿主，用桩跑。

## 9. 已知限制（说清楚，不粉饰）

1. **改不了正在跑的那一轮**，只能排到下一轮——宿主在 prompt 组装时快照选择，这是硬边界。
2. 成员默认路由变更**不会**作用于已存在成员，必须释放重建（roster 标 `STALE`）。
3. `sessions.json` 的条目在会话被删除后不会自动清理，需要 `/team-model ... clear` 或手工删。
4. 持久化只在 `agent/created` 与 `turn/start` 时生效，进程内 `pendingByName` 是内存态。
5. 依赖 `@deepseek-ai/dsh-agent` 导出 `installModelSelection`，旧版本会在调用时明确报错。
6. 与宿主自带 `/model` 同时使用时，两个 selection 监听器叠加，以最后注册者为准。
7. **不做请求失败换模型重试**：agent-loop 请求是 deep-frozen 且带 `isAgentLoopRequest` 标识，改 options 重跑会破坏会话日志可重建性。降级只处理 `unknown-provider` 这种必然失败的替换。
8. 没有任务标签自动调度（“这个任务用 A、那个任务用 B”需调用方显式指定成员）。

## 10. 代码结构

```
index.js              插件入口：工具 + 指令 + settings + 装配
lib/rules.js          路由规则归一化与匹配
lib/patch.js          包 spawn/startContinuable 注入 agentOptions
lib/overrides.js      next-turn/sticky 状态机（mid-turn 排队、turn/end 还原）
lib/pending.js        成员不在线时的排队路由
lib/store.js          rules.json 读写 + atomicWriteJson
lib/session-store.js  会话级 override 持久化
lib/audit.js          JSONL 审计
lib/catalog.js        llm 目录只读视图与校验
lib/aliases.js        别名归一化与 token 解析
lib/command.js        /team-model 语法解析与帮助
```

## 11. License

MIT
