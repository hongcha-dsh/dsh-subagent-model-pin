# dsh-subagent-model-pin

**所有子代理统一跑一个指定模型；发现越界立即打断并提醒主会话。**
目的：防止子代理继承主会话的高价模型（如 k3.1）把额度烧穿。

## 三个能力

| 能力 | 说明 |
|---|---|
| **钉住** | 所有子代理创建时 `agent.model.select()` 到统一目标路由；显式指定别的模型也会被覆盖（`honorExplicit: false`） |
| **越界打断** | 每个子代理挂 `agent/pre-step` 守卫，逐步核对即将进入的资源路由；不符就 `reject` 该步骤（**不发错模型的请求**）+ 中止该子代理 + 往父会话注入一条 ⚠️ 提醒 |
| **设置页** | 插件管理页 → 本插件 → 「配置」：下拉选 provider/model，勾选打断策略，保存即生效 |

## 它解决什么问题

DSH 的 `tool-subagent` 在委派调用**没有显式写 `provider`/`model`** 时，子代理会继承父会话模型
（源码 `resolveChildAgentOptions()`：父路由 + requested 覆盖，没有其它默认值）。

官方设置 `subagent-model-selection-settings` 的 `allowedModels` 只约束**显式选择**，纯继承被明确豁免
（源码注释：*Pure inheritance remains outside this policy because no model-facing choice occurred*）。
所以主会话用 k3.1 时，子代理也跑 k3.1，6 个并行就能一小时内打穿 Kimi 的 5 小时额度。

## 为什么不是"拦截调用补参数"

`@deepseek-ai/dsh-tools` 文档明确：**`tools/pre-execute` 有意不允许改写 `exec.arguments`**
（否则日志/呈现与实际执行失去同步，改写设计仍停在"拟议的 Agent Note"）。

## 原理

- **钉住**用 dsh-agent 官方模型 API：
  - `agent.model.current()` — 读待生效/已记录/实时 options 的选择
  - `agent.model.select({ provider, model, reasoningEffort? })` — 从下一个尚未准备的步骤生效
- **越界打断**用 `agent/pre-step` 瀑布事件：进入下一步前拿到该步已固定的 `modelSelection`，
  与目标路由比对；不符就返回 `{ kind: 'reject' }`，loop 会把该轮记为 `blocked` 且**根本不发请求**；
  同时 `agent.cancel({ kind: 'user' })` 中止该子代理，并 `parent.inject()` 一条提醒（注入不唤醒父会话、不额外耗 token）。

## 设置页 UI

插件管理页点本插件的「配置」即可：

- Provider / Model 下拉（来自 `ctx.llm.listProviders()` + `listModels()` 的实时目录）
- 模式：`pin — 钉住并越界打断` / `audit — 只记录，不干预`
- 三个勾选：越界即打断、尊重显式选择
- 越界记录列表（可清空）

保存走 `POST /plugins/subagent-model-pin/config`，写入插件目录 `config.json`，**立即生效**（无需重启）。

> 首次安装后需**刷新一次页面**（F5），新的 Client 模块才会加载；之后设置页常驻。

## 配置

Host 侧路由（诊断用）：`GET /plugins/subagent-model-pin/state` 返回当前配置、模型目录、越界记录。

`config.json`（也可以直接在插件目录改，热加载 ≤3 秒）：

```json
{
  "mode": "pin",
  "provider": "dsh-opencode-go",
  "model": "deepseek-v4.1-flash",
  "honorExplicit": false,
  "audit": true,
  "killOnViolation": true
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `pin` | `pin` 钉住+打断；`audit` 只记录、绝不干预 |
| `provider` / `model` | ds4.1 | 全局唯一的子模型路由 |
| `reasoningEffort` | 无 | 可选 |
| `honorExplicit` | `false` | false = 连显式指定的别的模型也覆盖（推荐）；true = 尊重显式选择 |
| `killOnViolation` | `true` | 越界即打断（仅 `pin` 模式） |
| `audit` | `true` | 写 `pin.jsonl` |

> 想跨 DSH 升级保留配置：在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 追加同名 id 的行
> （该层是用户补丁层，升级不会清掉）。

### 作用域：只管子代理，永不碰主会话

插件的管理对象是**子代理**（有父会话的 agent，或 origin 为 `subagent`）。
主会话不在作用域内 —— 你主窗口用什么模型完全由你自己决定，插件既不切换也不打断。

这是结构性保证，不是开关：早期版本有个 `includeRoot` 选项能让主会话也钉住，因为它会带来
"手动切回高价模型就把自己的主对话掐掉"的风险，已整个移除。

## 验证记录（2026-11-12 实测）

| 场景 | 结果 |
|---|---|
| 父会话 `opencode-go/ds4.1`，子代理不写模型 | 子会话 `model/selection` / `request/header` / 响应全为 `dsh-opencode-go/ds4.1`（`pin.jsonl`: `pinned`） |
| 目标故意设成另一个 provider | 子会话确实跑在目标 provider，证明是**真改写**而非继承 |
| 越界（目标与继承不一致，audit 模式） | 触发 `reject` + 中止子代理 + 父会话收到 ⚠️ 提醒，子代理未完成 |
| 显式传 `kimi-coding/kimi-k3.1-pro` | 被官方 allowedModels 拒绝（第二层防线） |
| 设置页保存 | `POST /config` 返回 ok，写盘成功，live 配置立即更新 |

## 卸载

`plugin_manager` → `remove_bundle`（`dsh-subagent-model-pin`）。

## 已知限制

- 依赖 `agent.model.select` / `current` / `pre-step.modelSelection`。DSH 升级若改这些 API，插件会写
  `no-select-api` / `error` 审计并**静默不生效**（全部逻辑 try/catch，不会让 agent 创建失败）；升级后看一次
  `pin.jsonl` 或设置页状态即可发现。
- 只影响**新创建**的子代理；已存在的子代理不追溯。
- `audit` 模式纯观察，不会打断任何东西。
- 审计文件在插件目录（`pin.jsonl`），重装 bundle 可能被清空，需要留档请自行导出。
