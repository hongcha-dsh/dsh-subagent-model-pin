// dsh-subagent-model-pin — Client module: the settings-page card.
// Registers into `plugins.row.config` keyed by "<bundle>#<rowId>", which makes the
// Plugin Manager show a "Configure" page for this plugin row.
window.__ModuleLoader__.load({
  id: 'dsh-subagent-model-pin',
  factory(require) {
    const report = (stage, detail) => {
      try {
        fetch('/plugins/subagent-model-pin/clientlog', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage, detail: detail === undefined ? '' : String(detail) }),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* diagnostics must never break the plugin */
      }
    }

    try {
      report('factory')
      const React = require('react')
      const h = React.createElement
      const API = '/plugins/subagent-model-pin'

      const box = { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 8px' }
      const card = {
        border: '1px solid rgba(127,127,127,0.28)',
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }
      const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
      const label = { fontSize: 12, opacity: 0.65, minWidth: 92 }
      const control = {
        padding: '3px 6px',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid rgba(127,127,127,0.35)',
        borderRadius: 6,
        font: 'inherit',
        fontSize: 12,
      }
      const button = {
        padding: '3px 12px',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid rgba(127,127,127,0.45)',
        borderRadius: 6,
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
      }
      const title = { fontSize: 13, fontWeight: 600 }
      const hint = { fontSize: 12, opacity: 0.65, lineHeight: 1.5 }
      const dot = (ok) => ({ width: 7, height: 7, borderRadius: '50%', background: ok ? '#3fb950' : '#d29922', display: 'inline-block' })

      function useState_() {
        const [state, setState] = React.useState(null)
        const [error, setError] = React.useState(null)
        const load = React.useCallback(async () => {
          try {
            const res = await fetch(API + '/state', { cache: 'no-store' })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const json = await res.json()
            setState(json)
            setError(null)
            return json
          } catch (e) {
            setError(String((e && e.message) || e))
            return null
          }
        }, [])
        React.useEffect(() => {
          load()
          const timer = setInterval(load, 5000)
          return () => clearInterval(timer)
        }, [load])
        return { state, error, refresh: load }
      }

      function SettingsCard() {
        const { state, error, refresh } = useState_()
        const [busy, setBusy] = React.useState(false)
        const [saved, setSaved] = React.useState(null)
        const cfg = state && state.config ? state.config : null
        const [draft, setDraft] = React.useState(null)
        React.useEffect(() => {
          if (cfg && draft === null) setDraft({ ...cfg })
        }, [cfg, draft])

        const routes = (state && state.routes) || []
        const providers = routes.length > 0 ? routes : []
        const currentProvider = draft ? draft.provider : ''
        const providerEntry = providers.find((p) => p.provider === currentProvider)
        const models = providerEntry ? providerEntry.models : []
        const violations = (state && state.violations) || []

        const set = (patch) => setDraft((prev) => ({ ...(prev || {}), ...patch }))

        const save = async () => {
          if (!draft) return
          setBusy(true)
          try {
            const res = await fetch(API + '/config', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(draft),
            })
            const json = await res.json()
            if (!res.ok) throw new Error(json && json.error ? json.error : 'HTTP ' + res.status)
            setDraft({ ...json.config })
            setSaved('已保存，新的子代理立即生效')
            setTimeout(() => setSaved(null), 3000)
            refresh()
          } catch (e) {
            setSaved('保存失败：' + String((e && e.message) || e))
          } finally {
            setBusy(false)
          }
        }

        const clearViolations = async () => {
          try {
            await fetch(API + '/violations', { method: 'POST' })
            refresh()
          } catch {
            /* ignore */
          }
        }

        return h('div', { style: box },
          h('div', { style: row },
            h('span', { style: dot(Boolean(cfg && cfg.provider)) }),
            h('span', { style: title }, '子代理模型钉住'),
            h('span', { style: hint },
              cfg ? '当前：' + cfg.provider + ' / ' + cfg.model + (cfg.mode === 'audit' ? '（只观察，不干预）' : '') : '读取中…')
          ),
          h('div', { style: hint },
            '所有子代理统一跑上面的模型；一旦发现子代理实际用了别的模型就立即打断并通知主会话。' +
            '保存后立即生效，写入插件目录 config.json。'),

          error ? h('div', { style: { ...hint, color: '#f85149' } }, '读取失败：' + error) : null,
          !draft ? h('div', { style: hint }, '加载中…') : h('div', { style: card },
            h('div', { style: row },
              h('span', { style: label }, 'Provider'),
              h('select', {
                style: control,
                value: draft.provider,
                onChange: (e) => {
                  const provider = e.target.value
                  const entry = providers.find((p) => p.provider === provider)
                  const model = entry && entry.models[0] ? entry.models[0].model : draft.model
                  set({ provider, model })
                },
              }, providers.length === 0
                ? h('option', { value: draft.provider }, draft.provider)
                : providers.map((p) => h('option', { key: p.provider, value: p.provider }, p.provider + ' — ' + p.name))),
              h('span', { style: label }, 'Model'),
              h('select', {
                style: control,
                value: draft.model,
                onChange: (e) => set({ model: e.target.value }),
              }, models.length === 0
                ? h('option', { value: draft.model }, draft.model)
                : models.map((m) => h('option', { key: m.model, value: m.model }, m.model + ' — ' + m.name)))
            ),
            h('div', { style: row },
              h('span', { style: label }, '模式'),
              h('select', {
                style: control,
                value: draft.mode,
                onChange: (e) => set({ mode: e.target.value }),
              },
                h('option', { value: 'pin' }, 'pin — 钉住并越界打断'),
                h('option', { value: 'audit' }, 'audit — 只记录，不干预')),
              h('label', { style: { ...hint, display: 'flex', gap: 6, alignItems: 'center' } },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(draft.killOnViolation),
                  onChange: (e) => set({ killOnViolation: e.target.checked }),
                }),
                '越界即打断'),
              h('label', { style: { ...hint, display: 'flex', gap: 6, alignItems: 'center' } },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(draft.honorExplicit),
                  onChange: (e) => set({ honorExplicit: e.target.checked }),
                }),
                '尊重显式选择'),
              h('label', { style: { ...hint, display: 'flex', gap: 6, alignItems: 'center' } },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(draft.includeRoot),
                  onChange: (e) => set({ includeRoot: e.target.checked }),
                }),
                '也管主会话')
            ),
            h('div', { style: row },
              h('button', { style: button, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
              saved ? h('span', { style: hint }, saved) : null
            )
          ),

          h('div', { style: card },
            h('div', { style: row },
              h('span', { style: title }, '越界记录'),
              h('span', { style: hint }, violations.length === 0 ? '暂无' : String(violations.length) + ' 条'),
              violations.length > 0 ? h('button', { style: button, onClick: clearViolations }, '清空') : null
            ),
            violations.length === 0
              ? h('div', { style: hint }, '还没有子代理跑过别的模型。')
              : violations.slice(0, 10).map((v, i) => h('div', {
                  key: i,
                  style: { ...hint, color: '#f85149' },
                }, (v.at || '') + ' · ' + (v.text || (v.from + ' → 期望 ' + v.want))))
          )
        )
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          try {
            ctx.slots.inject('plugins.row.config', () => {
              try {
                report('slot-inject-callback')
                return ctx.slots.register(
                  {
                    name: 'plugins.row.config',
                    id: 'subagent-model-pin-config',
                    key: 'dsh-subagent-model-pin#subagent-model-pin',
                    order: 10,
                  },
                  SettingsCard,
                )
              } catch (error) {
                report('slot-register-error', (error && error.message) || error)
                return undefined
              }
            })
            report('applied')
          } catch (error) {
            report('apply-error', (error && error.message) || error)
          }
        },
      }
    } catch (error) {
      report('factory-error', (error && error.stack) || error)
      throw error
    }
  },
})
