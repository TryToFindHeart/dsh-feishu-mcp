/**
 * 一个飞书私聊会话 ↔ 一个 DSH 会话的绑定与切换。
 *
 * 这里的会话列表来自可选的 sessionController / workspaceRegistry 服务；
 * 服务不可用时相关命令给出明确提示，而不是让插件加载失败。
 */

function basename(path) {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

/** 从完整会话 ID 提取稳定短码，避免自动重命名后找不到对应会话。 */
export function shortSessionId(value) {
  const raw = String(value || '')
  const alnum = raw.replace(/[^0-9a-z]/gi, '').slice(-8).toUpperCase()
  return alnum || raw.slice(-8).toUpperCase()
}

export function relativeTime(at, now = Date.now()) {
  const minutes = Math.round((now - Number(at || 0)) / 60000)
  if (!Number.isFinite(minutes) || minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/** 支持 ~ 与 ~/，Windows 上同时识别 USERPROFILE。 */
export function expandHome(input) {
  const text = String(input || '').trim()
  const home = String(process.env.USERPROFILE || process.env.HOME || '')
  if (!home) return text
  if (text === '~') return home
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return `${home}/${text.slice(2).replace(/\\/g, '/')}`
  }
  return text
}

export function createSessions({ ctx, readState, writeState, trace }) {
  /** chatId → 最近一次列出的会话，保证“/resume 2”指向用户看到的那一行。 */
  const lastListing = new Map()
  const LISTING_TTL_MS = 15 * 60 * 1000

  const get = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)

  async function list({ query = '', limit = 10 } = {}) {
    const controller = get('sessionController')
    if (!controller?.list) throw new Error('会话列表不可用（sessionController 未激活）')
    const listed = await controller.list({}, AbortSignal.timeout(15000))
    const items = Array.isArray(listed) ? listed : Array.isArray(listed?.items) ? listed.items : []
    const needle = String(query || '').trim().toLowerCase()
    const rows = []
    for (const item of items) {
      if (item.parentSessionId || item.origin === 'subagent' || item.hidden === true) continue
      // 归档会话不参与飞书按钮列表：它们不是可继续的会话。
      if (item.archived === true || item.isArchived === true || item.archivedAt || item.status === 'archived') continue
      const title = String(item.projections?.values?.title || '')
      const cwd = String(item.cwd || '')
      const label = title || basename(cwd) || String(item.sessionId).slice(0, 12)
      const haystack = `${label} ${cwd} ${item.sessionId}`.toLowerCase()
      if (needle && !haystack.includes(needle)) continue
      rows.push({
        sessionId: String(item.sessionId),
        shortId: shortSessionId(item.sessionId),
        title,
        label,
        cwd,
        running: item.running === true,
        updatedAt: Number(item.updatedAt || 0),
      })
      if (rows.length >= limit) break
    }
    return rows
  }

  function format(rows, currentId) {
    if (rows.length === 0) return '没有匹配的会话。'
    return rows.map((row, index) => {
      const meta = [row.running ? '运行中' : '', relativeTime(row.updatedAt)].filter(Boolean).join(' · ')
      const mark = String(row.sessionId) === String(currentId) ? ' ←当前' : ''
      return `${index + 1}. **${row.label}** · #${row.shortId || shortSessionId(row.sessionId)}${mark}\n　${meta}`
    }).join('\n')
  }

  function remember(chatId, rows) {
    lastListing.set(String(chatId), { rows, at: Date.now() })
  }

  function recent(chatId) {
    const entry = lastListing.get(String(chatId))
    if (!entry) return undefined
    if (Date.now() - entry.at > LISTING_TTL_MS) {
      lastListing.delete(String(chatId))
      return undefined
    }
    return entry.rows
  }

  /** 支持序号、完整/前缀 id、标题或目录片段。 */
  async function resolve(chatId, ref) {
    const text = String(ref || '').trim()
    if (!text) throw new Error('需要一个会话编号、id 或标题')
    const remembered = recent(chatId)

    if (/^\d+$/.test(text)) {
      const rows = remembered || (await list({ limit: 20 }))
      const row = rows[Number(text) - 1]
      if (!row) throw new Error(`没有第 ${text} 个会话；先发 /sessions 看看列表`)
      return row
    }

    const rows = remembered || (await list({ limit: 50 }))
    const byId = rows.find((row) => row.sessionId === text)
    if (byId) return byId
    const byPrefix = rows.find((row) => row.sessionId.startsWith(text))
    if (byPrefix) return byPrefix
    const needle = text.toLowerCase()
    const byText = rows.find((row) => `${row.label} ${row.title} ${row.cwd}`.toLowerCase().includes(needle))
    if (byText) return byText
    throw new Error(`没找到匹配「${text}」的会话；可以用 /sessions 关键字 过滤`)
  }

  async function ensureWorkspace(path, title) {
    const registry = get('workspaceRegistry')
    if (!registry?.create) return undefined
    try {
      const workspace = await registry.create(path, title || undefined)
      if (workspace && title && workspace.title !== title) await workspace.setTitle(title)
      return workspace
    } catch (error) {
      trace?.('workspace-ensure-failed', { path, message: String((error && error.message) || error) })
      return undefined
    }
  }

  async function switchTo(chatId, row) {
    const state = await readState()
    const next = {
      ...state,
      chatSessions: { ...(state.chatSessions || {}), [String(chatId)]: row.sessionId },
    }
    await writeState(next)
    trace?.('session-switched', { chat: String(chatId).slice(0, 10), session: row.sessionId.slice(0, 12) })
    return { row, state: next }
  }

  async function chatOfSession(sessionId) {
    const state = await readState()
    for (const [chatId, bound] of Object.entries(state.chatSessions || {})) {
      if (String(bound) === String(sessionId)) return { chatId, state }
    }
    return undefined
  }

  async function current(chatId) {
    const state = await readState()
    return state.chatSessions?.[String(chatId)]
  }

  return {
    list,
    format,
    remember,
    resolve,
    switchTo,
    chatOfSession,
    current,
    relativeTime,
    shortSessionId,
    ensureWorkspace,
    expandHome,
  }
}
