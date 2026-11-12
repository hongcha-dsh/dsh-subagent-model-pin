/**
 * dsh-subagent-model-pin — 子代理模型守门（Host-only bundle，零外部依赖）
 *
 * 三件事：
 *   1. 钉住：所有子代理创建时 `agent.model.select()` 到统一的目标子模型。
 *   2. 越界停止：每个子代理挂一个 `agent/pre-step` 守卫，逐步核对即将进入的资源路由；
 *      一旦偏离目标模型，立即 `reject` 该步骤（回合结束、不发错模型的请求），
 *      中止该子代理，并提醒父会话。
 *   3. 设置页：Host 暴露 /plugins/subagent-model-pin/* 路由，Client 设置页读取模型目录、
 *      保存选择到 config.json（热生效）。
 *
 * 为什么不改写委派参数：`tools/pre-execute` 有意禁止改写 exec.arguments。
 * 提示：所有逻辑 try/catch；任何异常只写审计，绝不让 agent 创建/运行失败。
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url))
const CONFIG_PATH = PLUGIN_DIR + 'config.json'
const AUDIT_PATH = PLUGIN_DIR + 'pin.jsonl'

const DEFAULTS = {
  mode: 'pin',
  provider: 'dsh-opencode-go',
  model: 'deepseek-v4.1-flash',
  reasoningEffort: undefined,
  /** false = 连显式指定的别的模型也覆盖（默认） */
  honorExplicit: false,
  /** 是否连根级主会话也钉 */
  includeRoot: false,
  /** 写审计 jsonl */
  audit: true,
  /** 发现越界就打断（默认 true） */
  killOnViolation: true,
}

const MAX_VIOLATIONS = 50

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function normalizeConfig(raw, base) {
  const merged = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) }
  const out = {
    ...merged,
    provider: typeof merged.provider === 'string' && merged.provider.length > 0 ? merged.provider : base.provider,
    model: typeof merged.model === 'string' && merged.model.length > 0 ? merged.model : base.model,
    mode: merged.mode === 'audit' ? 'audit' : 'pin',
    honorExplicit: merged.honorExplicit === true,
    includeRoot: merged.includeRoot === true,
    audit: merged.audit !== false,
    killOnViolation: merged.killOnViolation !== false,
  }
  if (typeof merged.reasoningEffort === 'string' && merged.reasoningEffort.length > 0) out.reasoningEffort = merged.reasoningEffort
  else delete out.reasoningEffort
  return out
}

export function apply(ctx, config) {
  const base = { ...DEFAULTS, ...(config ?? {}) }
  let live = normalizeConfig(undefined, base)
  let stamp = ''
  let lastRead = 0
  const violations = []
  const clientLog = []

  const refreshConfig = () => {
    const now = Date.now()
    if (now - lastRead < 1000) return
    lastRead = now
    try {
      const stat = fs.statSync(CONFIG_PATH)
      const next = String(stat.mtimeMs)
      if (next === stamp) return
      const parsed = readJsonFile(CONFIG_PATH)
      live = normalizeConfig(parsed, base)
      stamp = next
    } catch {
      live = normalizeConfig(undefined, base)
    }
  }

  const targetRoute = () => {
    const route = { provider: live.provider, model: live.model }
    if (live.reasoningEffort) route.reasoningEffort = live.reasoningEffort
    return route
  }

  const writeAudit = (entry) => {
    try {
      if (!live.audit) return
      fs.appendFileSync(AUDIT_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
    } catch {
      /* ignore */
    }
  }

  const recordViolation = (entry) => {
    violations.unshift(entry)
    if (violations.length > MAX_VIOLATIONS) violations.length = MAX_VIOLATIONS
    writeAudit({ event: 'violation', ...entry })
  }

  const agentOf = (id) => {
    try {
      return ctx.get('agents')?.get?.(id)
    } catch {
      return undefined
    }
  }

  const parentRouteOf = (agent) => {
    try {
      const parentId = agent?.session?.header?.parentSession
      if (!parentId) return undefined
      const parent = agentOf(parentId)
      const current = parent?.model?.current?.()
      if (!current?.provider || !current?.model) return undefined
      return { provider: current.provider, model: current.model }
    } catch {
      return undefined
    }
  }

  /** 提醒父会话：注入一条插件上下文（不唤醒父会话，不额外消耗一轮请求）。 */
  const notifyParent = (agent, text) => {
    try {
      const parentId = agent?.session?.header?.parentSession
      if (!parentId) return
      const parent = agentOf(parentId)
      if (!parent) return
      if (typeof parent.inject !== 'function') return
      parent.inject({
        content: [{ type: 'text', text }],
        source: { kind: 'subagent-model-pin' },
      })
    } catch {
      /* ignore */
    }
  }

  const isManaged = (header) => {
    if (!header) return false
    if (live.includeRoot) return true
    if (header.parentSession) return true
    return header.origin === 'subagent'
  }

  /** 硬中止：reject 当前步骤 + 取消该子代理，并提醒父会话。 */
  const stopChild = (agent, reason) => {
    try {
      if (typeof agent?.cancel === 'function') agent.cancel({ kind: 'user' })
    } catch {
      /* ignore */
    }
    notifyParent(agent, `⚠️ [subagent-model-pin] 子代理 ${String(agent?.id ?? '').slice(0, 8)} ${reason}，已中止。`)
  }

  /** 每个子代理一个逐步守卫：进入下一步前核对路由。 */
  const installGuard = (agent) => {
    try {
      const off = agent.ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        try {
          if (decision?.kind === 'reject') return decision
          refreshConfig()
          const want = targetRoute()
          const got = payload?.modelSelection
          if (!want.provider || !want.model) return decision
          if (got && got.provider === want.provider && got.model === want.model) return decision
          const gotText = got ? `${got.provider}/${got.model}` : '(unknown)'
          const detail = `越界使用模型 ${gotText}（应为 ${want.provider}/${want.model}）`
          recordViolation({ agent: agent?.id, session: agent?.session?.id, from: gotText, want: `${want.provider}/${want.model}`, text: detail })
          // audit 模式只记录，绝不干预；pin 模式按 killOnViolation 打断
          if (live.mode === 'pin' && live.killOnViolation) {
            stopChild(agent, detail)
            return { kind: 'reject' }
          }
          return decision
        } catch {
          return decision
        }
      })
      return off
    } catch {
      return undefined
    }
  }

  ctx.on('agent/created', ({ agent } = {}) => {
    let stage = 'init'
    try {
      refreshConfig()
      const header = agent?.session?.header
      stage = 'origin'
      if (!isManaged(header)) return

      stage = 'route'
      const want = targetRoute()
      if (!want.provider || !want.model) {
        writeAudit({ event: 'bad-config', agent: agent?.id })
        return
      }

      stage = 'current'
      const model = agent.model
      const current = typeof model?.current === 'function' ? model.current() : undefined

      stage = 'guard'
      // 只在"真子代理"（有父会话）上装越界打断。主会话即便 includeRoot=true 也绝不打断，
      // 否则用户手动切模型会把主对话直接掐掉。
      if (header?.parentSession) installGuard(agent)

      if (current && current.provider === want.provider && current.model === want.model) {
        writeAudit({ event: 'already', agent: agent?.id, want })
        return
      }

      stage = 'explicit'
      const parentRoute = parentRouteOf(agent)
      const explicit = Boolean(current && parentRoute && (current.provider !== parentRoute.provider || current.model !== parentRoute.model))
      if (explicit && live.honorExplicit) {
        writeAudit({ event: 'skip-explicit', agent: agent?.id, from: { provider: current.provider, model: current.model }, want })
        return
      }

      stage = 'mode'
      if (live.mode === 'audit') {
        writeAudit({ event: 'would-pin', agent: agent?.id, from: current ? { provider: current.provider, model: current.model } : null, want })
        return
      }

      stage = 'select'
      if (typeof model?.select !== 'function') {
        recordViolation({ agent: agent?.id, text: '当前 DSH 不支持 agent.model.select，无法钉住路由' })
        if (live.mode === 'pin' && live.killOnViolation) stopChild(agent, '无法钉住模型路由（agent.model.select 不可用）')
        return
      }
      model.select(want)
      writeAudit({ event: 'pinned', agent: agent?.id, from: current ? { provider: current.provider, model: current.model } : null, want })
    } catch (error) {
      try {
        ctx.logger?.warn?.(`[subagent-model-pin] ${stage}: ${error?.message ?? error}`)
      } catch {
        /* ignore */
      }
      writeAudit({ event: 'error', stage, agent: agent?.id, message: String(error?.message ?? error) })
      try {
        if (live.mode === 'pin' && live.killOnViolation) stopChild(agent, `钉住失败（${stage}: ${error?.message ?? error}）`)
      } catch {
        /* ignore */
      }
    }
  })

  // ---------------------------------------------------------------- HTTP routes
  const send = (res, code, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  const readBody = async (req, limit) => {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > limit) throw new Error('body too large')
    }
    return body
  }

  const listRoutes = async () => {
    try {
      const llm = ctx.get('llm')
      if (!llm) return []
      const providers = llm.listProviders()
      const out = []
      for (const provider of providers) {
        let models = []
        try {
          models = await llm.listModels(provider.id)
        } catch {
          models = []
        }
        out.push({
          provider: provider.id,
          name: provider.name ?? provider.id,
          models: (Array.isArray(models) ? models : []).map((model) => ({ model: model.id, name: model.name ?? model.id })),
        })
      }
      return out
    } catch {
      return []
    }
  }

  const stateSnapshot = async () => ({
    config: {
      mode: live.mode,
      provider: live.provider,
      model: live.model,
      reasoningEffort: live.reasoningEffort ?? null,
      honorExplicit: live.honorExplicit,
      includeRoot: live.includeRoot,
      audit: live.audit,
      killOnViolation: live.killOnViolation,
    },
    routes: await listRoutes(),
    violations: violations.slice(0, 20),
    clientLog: clientLog.slice(-20),
  })

  const installRoutes = (webCtx) => {
    const webServer = webCtx.webServer
    webCtx.effect(function* pinRoutes() {
      const offState = webServer.register({
        kind: 'exact',
        path: '/plugins/subagent-model-pin/state',
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' })
          try {
            send(res, 200, await stateSnapshot())
          } catch (error) {
            send(res, 500, { error: String(error?.message ?? error) })
          }
        },
      })
      const offConfig = webServer.register({
        kind: 'exact',
        path: '/plugins/subagent-model-pin/config',
        handler: async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
          try {
            const body = await readBody(req, 16384)
            const patch = body.length === 0 ? {} : JSON.parse(body)
            const next = normalizeConfig({ ...live, ...patch }, base)
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
            live = next
            try {
              stamp = String(fs.statSync(CONFIG_PATH).mtimeMs)
            } catch {
              /* ignore */
            }
            writeAudit({ event: 'config', config: next })
            send(res, 200, { ok: true, config: next })
          } catch (error) {
            send(res, 400, { error: String(error?.message ?? error) })
          }
        },
      })
      const offViolations = webServer.register({
        kind: 'exact',
        path: '/plugins/subagent-model-pin/violations',
        handler: (req, res) => {
          if (req.method === 'POST') {
            violations.length = 0
            send(res, 200, { ok: true })
            return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' })
          send(res, 200, { violations })
        },
      })
      const offDiag = webServer.register({
        kind: 'exact',
        path: '/plugins/subagent-model-pin/clientlog',
        handler: async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
          try {
            const body = await readBody(req, 4096)
            const entry = body.length === 0 ? {} : JSON.parse(body)
            clientLog.push({ at: new Date().toISOString(), stage: entry.stage, detail: entry.detail })
            if (clientLog.length > 50) clientLog.splice(0, clientLog.length - 50)
            send(res, 200, { ok: true })
          } catch {
            send(res, 200, { ok: false })
          }
        },
      })
      yield () => {
        offState()
        offConfig()
        offViolations()
        offDiag()
      }
    })
  }

  try {
    ctx.inject(['webServer'], installRoutes)
  } catch (error) {
    try {
      ctx.logger?.warn?.('[subagent-model-pin] cannot register routes: ' + String(error?.message ?? error))
    } catch {
      /* ignore */
    }
  }

  ctx.effect(function* pinLifecycle() {
    refreshConfig()
    yield () => {
      try {
        ctx.logger?.info?.('[subagent-model-pin] disposed')
      } catch {
        /* ignore */
      }
    }
  })
}
