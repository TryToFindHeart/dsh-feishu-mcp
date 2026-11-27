/**
 * Session model selection for the Feishu bridge.
 *
 * DSH exposes model choice through the session controller, the live Agent and
 * a durable `modelSelection` projection. This helper keeps the Feishu side
 * honest about which route a session uses — important when a paid model is
 * only a tap away — and provides one narrow method to change it.
 *
 * Two reads are exposed on purpose:
 * - `current()` is the selection the next step would take.
 * - `used()` is the route the latest request actually ran on (best for the
 *   footer of a finished turn).
 */

function get(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** Keep only a complete, printable route. */
function normalize(selection) {
  if (!selection?.provider || !selection?.model) return undefined
  return {
    provider: String(selection.provider),
    model: String(selection.model),
    ...(selection.reasoningEffort ? { reasoningEffort: String(selection.reasoningEffort) } : {}),
  }
}

/** Human-readable route: provider/model plus the catalog name when known. */
export function modelLabel(selection, catalog) {
  if (!selection?.provider || !selection?.model) return '默认模型（未读取到具体路由）'
  const group = catalog?.groups?.find((item) => item?.id === selection.provider)
  const model = group?.models?.find((item) => item?.id === selection.model)
  const name = model?.name ? `（${model.name}）` : ''
  const effort = selection.reasoningEffort ? ` · ${selection.reasoningEffort}` : ''
  return `${selection.provider}/${selection.model}${name}${effort}`
}

export function createModels({ ctx }) {
  const controller = () => get(ctx, 'sessionController')
  const agentOf = (sessionId) => (sessionId ? get(ctx, 'agents')?.get?.(sessionId) : undefined)

  /** Resolve a Session object from the event or the session store. */
  function sessionOf(sessionId, session) {
    if (session?.requestHeader) return session
    return (sessionId ? get(ctx, 'sessions')?.get?.(sessionId) : undefined)
  }

  /** Selection recorded by the live Agent (explicit choice or agent options). */
  function agentCurrent(sessionId) {
    return normalize(agentOf(sessionId)?.model?.current?.())
  }

  /**
   * Selection from the last recorded `request/header`. This is the actual
   * route used by the latest request, even when the Agent had no explicit
   * options (the common "default model" case).
   */
  function headerCurrent(sessionId, session) {
    try {
      const header = sessionOf(sessionId, session)?.requestHeader?.()
      const config = header?.config
      if (!config?.provider || !config?.model) return undefined
      // An effort the adapter defaulted is not a recorded choice.
      const reasoningEffort = header.adapterDefaults?.reasoningEffort === true ? undefined : config.reasoningEffort
      return normalize({ ...config, reasoningEffort })
    } catch {
      return undefined
    }
  }

  /** Durable projection view: `next` is the pending choice, `lastUsed` the last request. */
  function projectionOf(sessionId, session) {
    try {
      const live = sessionOf(sessionId, session)
      if (!live) return undefined
      return get(ctx, 'sessionProjections')?.snapshot?.(live)?.values?.modelSelection
    } catch {
      return undefined
    }
  }

  /** Selection the live session will use on its next step. */
  function current(sessionId, session) {
    return agentCurrent(sessionId)
      || normalize(projectionOf(sessionId, session)?.next)
      || headerCurrent(sessionId, session)
      || normalize(projectionOf(sessionId, session)?.lastUsed)
  }

  /** Selection the last request actually used; preferred for ended-turn notices. */
  function used(sessionId, session) {
    return headerCurrent(sessionId, session)
      || normalize(projectionOf(sessionId, session)?.lastUsed)
      || agentCurrent(sessionId)
      || normalize(projectionOf(sessionId, session)?.next)
  }

  /** Host-generation catalog, shared by all sessions. */
  async function catalog() {
    const api = controller()
    if (!api?.modelCatalog) return undefined
    try {
      return await api.modelCatalog()
    } catch {
      return undefined
    }
  }

  /** Record an explicit session-local model choice. */
  async function select(sessionId, provider, model) {
    const api = controller()
    if (!api?.selectModel) throw new Error('当前 DSH 版本不支持会话模型切换')
    // selectModel requires an explicitly resumed ordinary Session.
    if (api.resolveAgent) await api.resolveAgent(sessionId)
    const selected = await api.selectModel({
      sessionId,
      provider: String(provider),
      model: String(model),
    })
    return selected?.selected || selected
  }

  return { current, used, catalog, select }
}
