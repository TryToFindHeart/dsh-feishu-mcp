/**
 * Session model selection for the Feishu bridge.
 *
 * DSH exposes model choice through the session controller and a durable
 * `modelSelection` projection. This helper keeps the Feishu side honest about
 * which route a session will use next — important when a paid model is only a
 * tap away — and provides one narrow method to change it.
 */

function get(ctx, name) {
  return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
}

/** Human-readable route: provider/model plus the catalog name when known. */
export function modelLabel(selection, catalog) {
  if (!selection?.provider || !selection?.model) return '默认模型（未显式选择）'
  const group = catalog?.groups?.find((item) => item?.id === selection.provider)
  const model = group?.models?.find((item) => item?.id === selection.model)
  const name = model?.name ? `（${model.name}）` : ''
  const effort = selection.reasoningEffort ? ` · ${selection.reasoningEffort}` : ''
  return `${selection.provider}/${selection.model}${name}${effort}`
}

export function createModels({ ctx }) {
  const controller = () => get(ctx, 'sessionController')
  const agentOf = (sessionId) => (sessionId ? get(ctx, 'agents')?.get?.(sessionId) : undefined)

  /** Selection the live session will use; undefined when nothing is recorded. */
  function current(sessionId) {
    const selection = agentOf(sessionId)?.model?.current?.()
    if (!selection?.provider || !selection?.model) return undefined
    return {
      provider: String(selection.provider),
      model: String(selection.model),
      ...(selection.reasoningEffort ? { reasoningEffort: String(selection.reasoningEffort) } : {}),
    }
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

  return { current, catalog, select }
}
