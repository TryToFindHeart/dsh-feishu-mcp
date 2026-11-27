/**
 * Feishu → DSH.
 *
 * One Feishu conversation maps to one DSH session. A message that passes the
 * allowlist is admitted through `sessionController.prompt`, which resumes a cold
 * session and reuses the Feishu message id as the prompt request id — Feishu
 * retries events, and that id is what makes a retry a no-op instead of a second
 * turn.
 *
 * The turn's answer is not pushed by the generic notifier: `takeReply` hands the
 * pending chat to the notifier, which answers in the chat that asked.
 */

import { mkdir } from 'node:fs/promises'

import { PERMISSION_KEYS, PERMISSION_MODES } from './permissions.js'
import { shortSessionId } from './sessions.js'

/** Keep card labels short enough for a Feishu button. */
function clip(text, limit = 40) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`
}

import { addReaction, downloadFileResource, downloadImageResource, getTenantToken, removeReaction, sendText } from './feishu.js'
import { modelLabel } from './models.js'

const MAX_SEEN = 500

function textOf(message) {
  const type = message?.message_type
  if (type !== 'text') return null
  try {
    const parsed = JSON.parse(message.content || '{}')
    let text = typeof parsed.text === 'string' ? parsed.text : ''
    for (const mention of message.mentions || []) {
      if (mention && mention.key) text = text.split(mention.key).join('')
    }
    return text.replace(/\s+/g, ' ').trim()
  } catch {
    return null
  }
}

/**
 * Extract text, image keys and file references from a Feishu message.
 *
 * Image messages carry a single `image_key`; file messages carry a `file_key`
 * and a display name. Post messages may mix text, inline images and files.
 * All three become DSH prompt parts so the model sees real bytes, not a
 * placeholder mentioning that an attachment existed.
 */
function contentOf(message) {
  const type = message?.message_type
  let parsed = {}
  try {
    parsed = JSON.parse(message?.content || '{}') || {}
  } catch {
    parsed = {}
  }
  const empty = { text: null, imageKeys: [], fileRefs: [] }
  if (type === 'text') {
    let text = typeof parsed.text === 'string' ? parsed.text : ''
    for (const mention of message.mentions || []) {
      if (mention && mention.key) text = text.split(mention.key).join('')
    }
    return { text: text.replace(/\s+/g, ' ').trim(), imageKeys: [], fileRefs: [] }
  }
  if (type === 'image') {
    const key = typeof parsed.image_key === 'string' ? parsed.image_key : ''
    return { text: '', imageKeys: key ? [key] : [], fileRefs: [] }
  }
  if (type === 'file') {
    const key = typeof parsed.file_key === 'string' ? parsed.file_key : ''
    const name = typeof parsed.file_name === 'string' && parsed.file_name ? parsed.file_name : 'feishu-file'
    return { text: '', imageKeys: [], fileRefs: key ? [{ key, name }] : [] }
  }
  if (type === 'post') {
    const chunks = []
    const imageKeys = []
    const fileRefs = []
    const rows = Array.isArray(parsed.content) ? parsed.content : []
    for (const row of rows) {
      for (const part of Array.isArray(row) ? row : []) {
        if (!part || typeof part !== 'object') continue
        if (part.tag === 'text' && typeof part.text === 'string') chunks.push(part.text)
        if (part.tag === 'image' && typeof part.image_key === 'string') imageKeys.push(part.image_key)
        if (part.tag === 'file' && typeof part.file_key === 'string') {
          fileRefs.push({
            key: part.file_key,
            name: typeof part.file_name === 'string' && part.file_name ? part.file_name : 'feishu-file',
          })
        }
      }
    }
    if (typeof parsed.title === 'string' && parsed.title) chunks.unshift(parsed.title)
    return { text: chunks.join(' ').replace(/\s+/g, ' ').trim(), imageKeys, fileRefs }
  }
  return empty
}

function isBotSender(data) {
  const sender = data?.sender || {}
  return sender.sender_type === 'app' || sender.sender_type === 'bot'
}

/**
 * How a Feishu message enters a session.
 *
 * Running turn → `steer`: the message joins the turn in flight as guidance.
 * Idle turn   → `queue`: it is admitted as the next turn.
 * `/queue …`  → always `queue`, for "do this after the current task".
 */
export function deliveryMode(busy, wantsQueue = false) {
  return busy && !wantsQueue ? 'steer' : 'queue'
}

export function createInbound({ ctx, readState, writeState, log, trace, captures, onTextAnswer, sessions, models, restart, permissions, permissionCards, postCard, updateCardMessage }) {
  /** message ids already handled (Feishu redelivers on its own retry schedule). */
  const seen = new Set()
  const seenOrder = []
  /** sessionId → the chat waiting for that session's answer. */
  const pending = new Map()
  /** sessionId → the Typing reaction standing on the user's message. */
  const typing = new Map()
  /** sessionId → safety timer that clears a reaction if no turn/end arrives. */
  const typingTimers = new Map()
  /** chatId → the message id of the last session list card. */
  const listCards = new Map()
  /** chatId → the message id of the last model picker card. */
  const modelCards = new Map()

  /** The four permission modes, as buttons, with the current one marked. */
  function permissionCard(chatId, current, suggested) {
    const rows = []
    for (const key of PERMISSION_KEYS) {
      const mode = PERMISSION_MODES[key]
      rows.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: key === suggested ? `建议：${mode.label}` : (key === current ? `✓ ${mode.label}` : mode.label) },
            type: key === suggested ? 'primary' : 'default',
            value: { k: 'perm', c: chatId, m: key },
          },
        ],
      })
    }
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '会话权限' }, template: 'blue' },
      elements: [
        { tag: 'markdown', content: `**当前**：${PERMISSION_MODES[current]?.label || current}\n${PERMISSION_MODES[current]?.hint || ''}` },

        ...rows,
      ],
    }
  }

  /** Confirm a switch and name the route now in force, so a paid model never silently starts. */
  function switchedCard(label, modelText) {
    const lines = [`**${label}**`]
    if (modelText) {
      lines.push('', `**当前模型**：${modelText}`, '请确认这是你要用的模型，避免误跑付费模型。')
    }
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '✅ 已切换会话' }, template: 'green' },
      elements: [{ tag: 'markdown', content: lines.join('\n') }],
    }
  }

  /** Resolve the model a session will use on its next step. */
  async function modelHint(sessionId) {
    if (!models?.current) return ''
    try {
      const selection = models.current(sessionId)
      const catalog = await models.catalog?.()
      return modelLabel(selection, catalog)
    } catch (error) {
      trace?.('model-hint-failed', { message: String((error && error.message) || error).slice(0, 160) })
      return ''
    }
  }

  /** Post a one-button-per-model card; clicking one switches the session route. */
  async function showModels(chatId, sessionId) {
    if (!models?.catalog) {
      await reply(chatId, '这个 DSH 版本没有开放模型目录，无法切换。')
      return
    }
    const catalog = await models.catalog()
    const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
    const rows = []
    for (const group of groups) {
      for (const model of Array.isArray(group?.models) ? group.models : []) {
        if (model?.id) rows.push({ provider: group.id, id: model.id, name: model.name || model.id })
      }
    }
    if (rows.length === 0) {
      await reply(chatId, '当前没有可用的模型列表。')
      return
    }
    const current = models.current(sessionId)
    const elements = [
      { tag: 'markdown', content: `**当前模型**：${modelLabel(current, catalog)}\n点下面的按钮切换；切换只影响这个会话，下一轮生效。注意确认是否付费模型。` },
    ]
    for (const row of rows.slice(0, 20)) {
      const active = current?.provider === row.provider && current?.model === row.id
      elements.push({
        tag: 'action',
        actions: [buttonWithValue(
          `${active ? '✓ ' : ''}${row.name} · ${row.provider}`,
          active ? 'primary' : 'default',
          { k: 'model', p: row.provider, m: row.id, s: sessionId },
        )],
      })
    }
    const posted = await postCard(chatId, {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '切换会话模型' }, template: 'blue' },
      elements,
    })
    if (posted?.messageId) modelCards.set(chatId, posted.messageId)
    trace?.('model-card-posted', { count: Math.min(rows.length, 20), session: String(sessionId).slice(0, 12) })
  }

  function buttonWithValue(label, type, value) {
    return { tag: 'button', text: { tag: 'plain_text', content: label }, type, value }
  }

  function markSeen(id) {
    if (seen.has(id)) return false
    seen.add(id)
    seenOrder.push(id)
    if (seenOrder.length > MAX_SEEN) {
      const dropped = seenOrder.shift()
      if (dropped !== undefined) seen.delete(dropped)
    }
    return true
  }

  /** Hand the waiting chat to the notifier; absent when this turn was not ours. */
  function takeReply(sessionId) {
    const key = String(sessionId)
    const entry = pending.get(key)
    if (entry === undefined) return undefined
    pending.delete(key)
    return entry
  }

  /**
   * Resolve a Host service without declaring it as a hard dependency: the plugin
   * must still load in compositions that omit the session APIs, and `ctx.get`
   * is the documented optional-access form.
   */
  function service(name) {
    const value = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (value === undefined) throw new Error(`Host 服务 ${name} 不可用`)
    return value
  }

  /** Hand the standing Typing reaction to whoever answers the turn. */
  function takeTyping(sessionId) {
    const key = String(sessionId)
    const entry = typing.get(key)
    if (entry === undefined) return undefined
    typing.delete(key)
    const timer = typingTimers.get(key)
    if (timer) clearTimeout(timer)
    typingTimers.delete(key)
    return entry
  }

  /**
   * Mark the user's message as being worked on.
   *
   * Feishu renders no bot typing state; a `Typing` reaction on the incoming
   * message is the visible equivalent, and the notifier removes it when the turn
   * ends. A missing reaction scope degrades to no indicator.
   */
  async function markTyping(state, sessionId, messageId) {
    try {
      const token = await getTenantToken(state.appId, state.appSecret, state.domain)
      const result = await addReaction(token, state.domain, messageId, 'Typing')
      if (result?.reactionId) {
        const key = String(sessionId)
        const standing = { messageId, reactionId: result.reactionId }
        typing.set(key, standing)
        // Safety net: if no turn/end reaches the notifier, retire the badge
        // rather than leaving a "thinking" reaction on the user's message.
        const timer = setTimeout(async () => {
          if (typing.get(key)?.reactionId !== standing.reactionId) return
          typing.delete(key)
          typingTimers.delete(key)
          try {
            const fresh = await getTenantToken(state.appId, state.appSecret, state.domain)
            await removeReactionQuietly(fresh, state.domain, standing)
            trace?.('typing-timeout-cleared', {})
          } catch (error) {
            trace?.('typing-timeout-failed', { message: String((error && error.message) || error).slice(0, 160) })
          }
        }, 10 * 60 * 1000)
        timer.unref?.()
        typingTimers.set(key, timer)
      } else trace?.('typing-unavailable', { error: String(result?.error || 'unknown') })
    } catch (error) {
      trace?.('typing-unavailable', { error: String((error && error.message) || error) })
    }
  }

  async function removeReactionQuietly(token, domain, standing) {
    await removeReaction(token, domain, standing.messageId, standing.reactionId).catch(() => {})
  }

  async function reply(chatId, text) {
    const state = await readState()
    if (!state.appId || !state.appSecret) return
    const token = await getTenantToken(state.appId, state.appSecret, state.domain)
    await sendText(token, state.domain, { receiveId: chatId, receiveIdType: 'chat_id', text })
  }

  /** List sessions as a card with one switch button per row. */
  async function showSessions(chatId, query) {
    if (!sessions) {
      await reply(chatId, '会话列表不可用。')
      return
    }
    const state = await readState()
    const configured = Number(state.sessionSwitchLimit)
    // 0 表示不限，但卡片硬上限 20，避免飞书卡片过长。
    const limit = configured > 0 ? Math.max(1, Math.min(20, configured)) : 20
    let rows
    try {
      rows = await sessions.list({ query, limit })
    } catch (error) {
      await reply(chatId, `读取会话失败：${String((error && error.message) || error)}`)
      return
    }
    sessions.remember(chatId, rows)
    const currentId = await sessions.current(chatId)
    // The card carries no list of titles: each button IS the entry, labelled
    // with the title and when it was last touched.
    const elements = [
      {
        tag: 'markdown',
        content: rows.length > 0
          ? `点下面的会话按钮直接切换（最多 ${limit} 个）。要按关键字筛选，发 \`/sessions <关键字>\`。`
          : '没有匹配的会话。换个关键字试试：`/sessions <关键字>`。',
      },
    ]
    if (rows.length > 0) {
      const buttons = rows.slice(0, limit).map((row, index) => {
        const marker = row.sessionId === currentId ? ' ✓' : ''
        const code = row.shortId || shortSessionId(row.sessionId)
        const label = `${index + 1}. ${clip(row.label, 20)} · #${code}${marker}`
        return {
          tag: 'button',
          type: row.sessionId === currentId ? 'primary' : 'default',
          text: { tag: 'plain_text', content: label },
          value: { k: 'resume', sid: row.sessionId, label: row.label },
        }
      })
      // One button per action row keeps the numbered sequence tidy and clickable.
      for (const button of buttons) {
        elements.push({ tag: 'action', actions: [button] })
      }
    }
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: query ? `📋 会话（${query}）` : '📋 会话列表' }, template: 'blue' },
      elements,
    }
    try {
      const sent = await postCard(chatId, card)
      if (sent?.messageId) listCards.set(chatId, sent.messageId)
    } catch (error) {
      await reply(chatId, `${sessions.format(rows, currentId)}\n\n（卡片发送失败：${String((error && error.message) || error)}）`)
    }
  }

  async function newSession() {
    // New Feishu conversations live in their own folder and workspace, both
    // configurable in Settings; the home default keeps them out of the project
    // tree the operator opened in the web UI.
    const state = await readState()
    const configured = sessions?.expandHome?.(state.sessionCwd) || ''
    const cwd = configured ||
      ctx.get?.('workingDirectory')?.defaultDirectory ||
      process.env.DSH_WORKSPACE ||
      process.cwd()
    try {
      // A missing folder is the normal first-run case, not an error.
      await mkdir(cwd, { recursive: true })
    } catch (error) {
      trace?.('session-cwd-failed', { cwd, message: String((error && error.message) || error) })
    }
    // Creating *through* the workspace is what puts the session in the group:
    // `create({cwd})` only sets the directory, it never attaches the session.
    const workspace = await sessions?.ensureWorkspace?.(cwd, state.workspaceTitle)
    const request = workspace && workspace.id ? { workspaceId: workspace.id } : { cwd }
    const created = await service('sessionController').create(request)
    trace?.('session-created', { workspace: workspace?.id ? 'attached' : 'cwd-only' })
    return created.sessionId
  }

  async function handle(data) {
    let chatId = ''
    try {
      if (!data || !data.message) return
      if (isBotSender(data)) return

      const message = data.message
      const messageId = String(message.message_id || '')
      if (!messageId || !markSeen(messageId)) return
      if (message.chat_type === 'group' && !(message.mentions || []).length) return

      const { text, imageKeys, fileRefs } = contentOf(message)
      chatId = String(message.chat_id || '')
      const openId = String(data.sender?.sender_id?.open_id || '')
      if (!chatId) return

      const state = await readState()
      if (!state.appId || !state.appSecret) {
        trace?.('inbound-skip', { reason: 'not-configured' })
        return
      }

      if (!text && imageKeys.length === 0 && fileRefs.length === 0) {
        await reply(chatId, '目前只处理文本、图片和文件消息。')
        return
      }

      const safeText = text || ''
      const allowlist = state.allowedOpenIds
      if (!allowlist.includes(openId)) {
        if (allowlist.length > 0) {
          trace?.('inbound-denied', { openId: openId.slice(0, 8) })
          return
        }
        // First contact with no allowlist configured: claim this user, because
        // only the app's own owner can reach a bot that was just created.
        const claimed = await writeState({ ...state, allowedOpenIds: [openId], ownerOpenId: state.ownerOpenId || openId })
        trace?.('inbound-claimed', { openId: openId.slice(0, 8) })
        await reply(chatId, '已把你设为这个机器人的唯一使用者。之后的对话都会转给 DSH。')
        state.allowedOpenIds = claimed.allowedOpenIds
      }

      // An armed "type your answer" capture owns the next message in this chat,
      // even when commands are disabled: it answers a prompt, it does not steer
      // the session.
      if (captures?.peek(chatId)) {
        if ((imageKeys.length > 0 || fileRefs.length > 0) && !safeText) {
          await reply(chatId, '这个问题需要用文字回答；请发一条文字消息。')
          return
        }
        const consumed = await onTextAnswer?.(chatId, safeText)
        if (consumed) {
          trace?.('inbound-answer-captured', { chars: safeText.length })
          return
        }
      } else if (captures?.takeExpired(chatId)) {
        // The capture timed out between two messages: say so once, then route
        // this message the ordinary way.
        trace?.('inbound-capture-expired', {})
        await reply(chatId, 'ℹ️ 之前的“输入答案”已超时，会话已切回原来的 DSH 会话；这句话会照常发给它。')
      }

      if (!state.allowCommands) {
        await reply(chatId, '在 DSH 设置里关闭了「允许在飞书里指挥」——现在只接收通知。')
        return
      }

      const command = safeText.startsWith('/') ? safeText.split(/\s+/)[0].toLowerCase() : ''

      // 专用触发词：返回一排会话按钮，点按钮即切换；不走 DSH prompt，
      // 也不占用 /sessions 的筛选语义，避免和普通指令冲突。
      if (safeText === '切换会话' || safeText === '/切换会话') {
        await showSessions(chatId, '')
        return
      }

      if (command === '/help') {
        await reply(chatId, [
          '直接把要做的事发给我就行，文本、图片和文件都支持；另外支持：',
          '切换会话（或 /切换会话）返回一排会话按钮，点一下就切换',
          '/sessions [关键字]（或 /history）列出会话并点按钮切换',
          '/resume <编号|id|标题> 切换当前会话',
          '/current 看当前绑定',
          '/new 开一个新会话',
          '/restart 重启 DSH（有任务在跑时会拒绝）',
          '/queue <内容> 排队处理（默认在任务运行时是插话引导）',
          '/permission（或 /mode）查看或切换本对话的权限模式',
          '/model 查看并切换本会话模型（注意付费模型）',
          '/stop 让当前会话停下',
          '/id 看当前会话 id 与名称',
          '/help 这条说明',
        ].join('\n'))
        return
      }

      if (command === '/sessions' || command === '/history') {
        await showSessions(chatId, safeText.slice(command.length).trim())
        return
      }

      if (command === '/current') {
        const state0 = await readState()
        const currentId = state0.chatSessions?.[chatId]
        if (!currentId) {
          await reply(chatId, '这个对话还没绑定会话；发一句话就会自动开一个，或用 /sessions 选一个。')
          return
        }
        let label = String(currentId)
        try {
          const row = await sessions?.resolve(chatId, currentId)
          if (row) label = row.label
        } catch {
          // keep the id
        }
        await reply(chatId, `当前会话：${label}\n${currentId}`)
        return
      }

      if (command === '/resume') {
        const ref = safeText.slice(command.length).trim()
        if (!ref) {
          await reply(chatId, '用法：/resume <编号|id|标题>；先发 /sessions 看列表。')
          return
        }
        try {
          const row = await sessions.resolve(chatId, ref)
          await sessions.switchTo(chatId, row)
          // The switch result belongs in the card that listed the sessions, not
          // in a new message: the list is replaced by the bound title.
          const cardId = listCards.get(chatId)
          const hint = await modelHint(row.sessionId)
          if (cardId) {
            await updateCardMessage?.(cardId, switchedCard(row.label, hint))
            listCards.delete(chatId)
          } else {
            await reply(chatId, `已切换到「${row.label}」。\n接下来的消息都会发给这个会话。${hint ? `\n当前模型：${hint}（请确认，避免误跑付费模型）` : ''}`)
          }
        } catch (error) {
          await reply(chatId, `切换失败：${String((error && error.message) || error)}`)
        }
        return
      }

      let sessionId = state.chatSessions?.[chatId]

      // 关闭 Webhook 后，通知器记下了最近一次通知所属的会话。这个对话还没绑定
      // 时，静默跟随过去：下一条消息会回到通知里那个会话，而不是另开一个。
      if (!sessionId && state.followNoticeSwitch !== false && state.lastNoticeSessionId) {
        sessionId = state.lastNoticeSessionId
        state.chatSessions = { ...(state.chatSessions || {}), [chatId]: sessionId }
        state.homeChatId = state.homeChatId || chatId
        await writeState({ ...state, lastNoticeSessionId: '', lastNoticeAt: 0 })
        trace?.('silent-follow-notice', { chat: String(chatId).slice(0, 10), session: String(sessionId).slice(0, 12) })
      }

      if (command === '/new') {
        sessionId = await newSession()
        await writeState({ ...state, chatSessions: { ...(state.chatSessions || {}), [chatId]: sessionId } })
        await permissions?.applyToSession?.(sessionId, permissions.modeOf(await readState(), chatId))
        await reply(chatId, `新会话已开好：${sessionId}\n接下来发什么都进这个会话。`)
        return
      }

      if (!sessionId) {
        sessionId = await newSession()
        await writeState({
          ...state,
          chatSessions: { ...(state.chatSessions || {}), [chatId]: sessionId },
          homeChatId: state.homeChatId || chatId,
        })
        await permissions?.applyToSession?.(sessionId, permissions.modeOf(await readState(), chatId))
      }

      if (command === '/model') {
        await showModels(chatId, sessionId)
        return
      }

      if (command === '/permission' || command === '/mode') {
        const argument = safeText.slice(command.length).trim().toLowerCase()
        const state = await readState()
        const current = permissions.effectiveMode(state, chatId, state.chatSessions?.[chatId])
        // Even with an argument nothing changes until the confirmation card is
        // accepted; the argument only pre-selects.
        const suggested = PERMISSION_KEYS.includes(argument) ? argument : undefined
        const card = permissionCard(chatId, current, suggested)
        const posted = await postCard(chatId, card)
        // Remembered so the answerer can retire this card by chat when the click
        // payload carries no message id.
        if (posted?.messageId) permissionCards?.set(chatId, posted.messageId)
        return
      }

      if (command === '/restart') {
        const result = await restart.request({ sessionId, reason: '来自飞书 /restart' })
        await reply(
          chatId,
          result.ok
            ? '🔁 正在重启 DSH；进程起来后我会再发一条「已重启完成」，刷新页面即可继续。'
            : `没有重启：${result.error}`,
        )
        return
      }

      if (command === '/stop') {
        const agent = typeof ctx.get === 'function' ? ctx.get('agents')?.get?.(sessionId) : undefined
        if (!agent) {
          await reply(chatId, '这个会话当前没有在跑。')
          return
        }
        try {
          agent.cancel({ kind: 'user' })
          await reply(chatId, '已让它停下。')
        } catch (error) {
          await reply(chatId, `停不下来：${String((error && error.message) || error)}`)
        }
        return
      }

      if (command === '/id') {
        let label = ''
        try {
          const row = await sessions?.resolve?.(chatId, sessionId)
          label = String(row?.label || row?.title || '')
        } catch {
          // 名称拿不到时只回 ID，不影响命令本身。
        }
        if (!label) {
          try {
            const live = typeof ctx.get === 'function' ? ctx.get('sessions')?.get?.(sessionId) : undefined
            label = String(live?.projections?.values?.title || '')
          } catch {
            // 名称拿不到时只回 ID，不影响命令本身。
          }
        }
        await reply(chatId, label
          ? `会话名称：${label}\n会话 ID：${sessionId}\n继续发消息即可。`
          : `会话 ID：${sessionId}\n继续发消息即可。`)
        return
      }

      let body = command === '' ? safeText : safeText.slice(command.length).trim()
      if (!body && imageKeys.length > 0) body = '请识别这张图片并描述内容。'
      if (!body && fileRefs.length > 0) {
        body = fileRefs.length === 1
          ? `请处理这个文件：${fileRefs[0].name}`
          : `请处理这些文件：${fileRefs.map((file) => file.name).join('、')}`
      }
      if (!body) {
        await reply(chatId, '命令后面还需要内容，或者直接说要做的事。')
        return
      }

      // Download images with the app token and stage files for the target
      // session before prompt admission. DSH accepts image bytes inline and
      // files by the opaque receipt returned from a same-session upload.
      const contentParts = [{ type: 'text', text: body }]
      const fileUploads = typeof ctx.get === 'function' ? ctx.get('fileUploads') : undefined
      if (imageKeys.length > 0 || fileRefs.length > 0) {
        try {
          const token = await getTenantToken(state.appId, state.appSecret, state.domain)
          for (const imageKey of imageKeys) {
            const image = await downloadImageResource(token, state.domain, messageId, imageKey)
            contentParts.push({ type: 'image', mediaType: image.mediaType, data: image.data, name: image.name })
          }
          trace?.('inbound-images', { count: imageKeys.length, bytes: contentParts.slice(1).reduce((sum, part) => sum + (part.data?.length || 0), 0) })
          let fileBytes = 0
          for (const fileRef of fileRefs) {
            if (!fileUploads?.uploadStream) throw new Error('当前 DSH 版本不支持文件识别，请升级 Harness')
            const file = await downloadFileResource(token, state.domain, messageId, fileRef.key, fileRef.name)
            async function* chunks(bytes, size = 1024 * 1024) {
              for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size)
            }
            const uploaded = await fileUploads.uploadStream({
              sessionId,
              data: chunks(file.bytes),
              name: file.name,
            })
            if (!uploaded?.receiptId) throw new Error('文件上传没有返回回执')
            fileBytes += uploaded.file?.bytes || 0
            contentParts.push({ type: 'file', receiptId: uploaded.receiptId })
          }
          trace?.('inbound-files', { count: fileRefs.length, bytes: fileBytes })
        } catch (error) {
          trace?.('inbound-attachment-failed', { message: String((error && error.message) || error).slice(0, 160) })
          await reply(chatId, `附件下载或上传失败：${String((error && error.message) || error)}`)
          return
        }
      }

      const agent = typeof ctx.get === 'function' ? ctx.get('agents')?.get?.(sessionId) : undefined
      // Re-assert the chat's permission mode on every message: the sandbox part
      // is durable, the approval policy is not, and a Host restart resets it.
      await permissions?.ensureForSession?.(chatId, sessionId, await readState())
      const busy = agent?.status === 'running'
      trace?.('inbound-prompt', { session: String(sessionId).slice(0, 12), chars: body.length, busy })
      pending.set(String(sessionId), { chatId, at: Date.now(), messageId })
      await markTyping(state, sessionId, messageId)

      /*
       * While a turn is running the default is *steering* (`mode: 'steer'`):
       * the message joins the turn in flight as guidance instead of queueing a
       * second one behind it. `/queue <text>` asks for the old behaviour, and a
       * `/stop`-first flow stays available for a hard interrupt.
       */
      const wantsQueue = command === '/queue'
      const mode = deliveryMode(busy, wantsQueue)
      if (wantsQueue) trace?.('inbound-queue-requested', { session: String(sessionId).slice(0, 12) })

      try {
        await service('sessionController').prompt(
          {
            requestId: `feishu:${messageId}`,
            sessionId,
            mode,
            content: contentParts,
          },
          // The controller takes a caller signal, not a source: it derives the
          // message source itself. Aborting only cancels admission.
          AbortSignal.timeout(30_000),
        )
        if (mode === 'steer') {
          await reply(
            chatId,
            '⚡ 已插话：这条会作为当前这一轮的补充指令，和正在跑的任务一起生效，不会另起一轮。'
              + '\n想等这一轮结束再处理，就在前面加 /queue；想直接打断，发 /stop。',
          )
        } else if (busy && wantsQueue) {
          await reply(chatId, '已排队：当前这一轮结束后就处理这条。')
        }
      } catch (error) {
        const message = String((error && error.message) || error)
        // Steering is only legal while the turn still accepts it (an approval
        // pause, for example, does not). Falling back keeps the message instead
        // of dropping it on the floor.
        if (mode === 'steer' && /steer-unavailable|no longer accepts steering/i.test(message)) {
          trace?.('inbound-steer-unavailable', { session: String(sessionId).slice(0, 12) })
          try {
            await service('sessionController').prompt(
              {
                requestId: `feishu:${messageId}`,
                sessionId,
                mode: 'queue',
                content: contentParts,
              },
              AbortSignal.timeout(30_000),
            )
            await reply(chatId, '这一轮现在不接受插话（可能在等你批准某事），这条改成排队，本轮结束后处理。')
            return
          } catch (retryError) {
            trace?.('inbound-queue-failed', { message: String((retryError && retryError.message) || retryError).slice(0, 160) })
          }
        }
        pending.delete(String(sessionId))
        const standing = takeTyping(sessionId)
        if (standing) {
          const token = await getTenantToken(state.appId, state.appSecret, state.domain).catch(() => undefined)
          if (token) await removeReactionQuietly(token, state.domain, standing)
        }
        trace?.('inbound-failed', { message: message.slice(0, 200) })
        await reply(chatId, `没能把消息交给 DSH：${message}`)
      }
    } catch (error) {
      const message = String((error && error.message) || error)
      log(`[feishu-mcp] inbound failed: ${message}`)
      trace?.('inbound-error', { message: message.slice(0, 200) })
      if (chatId) {
        // Silence is the worst failure mode for a chat bridge: say what broke.
        await reply(chatId, `DSH 侧处理这条消息时出错了：${message}`).catch(() => {})
      }
    }
  }

  return { handle, takeReply, takeTyping }
}
