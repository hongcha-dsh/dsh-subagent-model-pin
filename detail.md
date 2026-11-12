# 子代理模型钉住

解决"主会话用高价模型时，子代理跟着继承高价模型把额度烧穿"的问题。

- **钉住**：所有子代理创建时统一改为插件里配置的子模型（默认 `dsh-opencode-go / deepseek-v4.1-flash`）。
- **越界打断**：每个子代理逐步核对模型路由，一旦发现实际要用别的模型，立即打断该子代理并通知主会话。
- **设置页**：插件管理页里点本插件的"配置"，下拉选 provider/model，保存即生效。

配置写在插件目录 `config.json`（可热改），也可在 profile 的 `cordis.patch.yml` 里覆盖同名行。

机制说明：DSH 禁止改写工具调用参数（`tools/pre-execute`），所以用 dsh-agent 的
`agent.model.select()` 在子代理创建时改路由；用 `agent/pre-step` 在每一步进入前核对
`modelSelection`，不符就 `reject` 该步骤（回合结束，不发错模型的请求）。
