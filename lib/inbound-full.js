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
import { NO_MODEL_FOOTER } from './card.js'

/** Keep card labels short enough for a Feishu button. */
function clip(text, limit = 40) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`
}

import { addReaction, downloadFileResource, downloadImageResource, getMessage, getTenantToken, listFolderFiles, removeReaction, sendText } from './feishu.js'
import { modelLabel } from './models.js'
import { annotateFeishuLinks, extractFeishuLinks } from './links.js'
import { blueTextCard, sessionStatusText } from './session-status.js'

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
 * and a display name. Folder messages carry a folder `file_key` and are marked
 * `folder: true`, so the download step expands them into their real files.
 * Post messages may mix text, inline images, files and folder attachments.
 * All become DSH prompt parts so the model sees real bytes, not a placeholder
 * mentioning that an attachment existed.
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
  if (type === 'folder') {
    const key = typeof parsed.file_key === 'string' ? parsed.file_key : ''
    const name = typeof parsed.file_name === 'string' && parsed.file_name ? parsed.file_name : 'feishu-folder'
    return { text: '', imageKeys: [], fileRefs: key ? [{ key, name, folder: true }] : [] }
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
        if (part.tag === 'a' && typeof part.href === 'string') chunks.push(part.href)
        if (part.tag === 'image' && typeof part.image_key === 'string') imageKeys.push(part.image_key)
        if (part.tag === 'file' && typeof part.file_key === 'string') {
          fileRefs.push({
            key: part.file_key,
            name: typeof part.file_name === 'string' && part.file_name ? part.file_name : 'feishu-file',
            folder: part.is_folder === true,
          })
        }
      }
    }
    // 富文本消息的附件也可能放在顶层 files 数组里，而不是 content 行内。
    for (const item of Array.isArray(parsed.files) ? parsed.files : []) {
      if (!item || typeof item.file_key !== 'string') continue
      if (fileRefs.some((ref) => ref.key === item.file_key)) continue
      fileRefs.push({
        key: item.file_key,
        name: typeof item.file_name === 'string' && item.file_name ? item.file_name : 'feishu-file',
        folder: item.is_folder === true,
      })
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

/** Feishu reply/quote ids carried by a text message. */
function quotedMessageIds(message) {
  const ids = new Set()
  for (const key of ['parent_id', 'root_id']) {
    if (message?.[key]) ids.add(String(message[key]))
  }
  const quote = message?.quote
  if (Array.isArray(quote)) {
    for (const item of quote) {
      const id = item?.message_id || item?.messageId || item?.id
      if (id) ids.add(String(id))
    }
  } else if (quote && typeof quote === 'object') {
    const id = quote.message_id || quote.messageId || quote.id
    if (id) ids.add(String(id))
    for (const key of ['message_ids', 'messageIds']) {
      if (!Array.isArray(quote[key])) continue
      for (const item of quote[key]) {
        const quoted = typeof item === 'object' ? (item?.message_id || item?.messageId || item?.id) : item
        if (quoted) ids.add(String(quoted))
      }
    }
  }
  try {
    const content = JSON.parse(message?.content || '{}')
    if (content?.quote) {
      for (const id of quotedMessageIds({ quote: content.quote })) ids.add(id)
    }
  } catch {}
  return ids
}

function fileChoiceCard(id, names, chatId) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '📎 收到文件' }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `文件：${names}\n请选择下一步：` } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '什么也不做' },
            type: 'default',
            value: { k: 'filechoice', id, v: 'noop', c: chatId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '输入文本' },
            type: 'primary',
            value: { k: 'filechoice', id, v: 'input', c: chatId },
          },
        ],
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '误发可点「什么也不做」；稍后在文字里引用这个文件，仍可把它一起交给 DSH。' }],
      },
    ],
  }
}

function fileStateCard(names, choice) {
  const ignored = choice === 'noop'
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: ignored ? '已忽略文件' : '等待文字说明' }, template: ignored ? 'grey' : 'blue' },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `文件：${names}\n${ignored ? '已忽略。稍后在文字里引用它，仍可一起处理。' : '请在下一条消息里输入说明（可引用其他文件）。'}`,
        },
      },
    ],
  }
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
  /** chatId → Map<fileId, staged file entry>; files stay available until used. */
  const stagedFiles = new Map()
  /** fileId → where its choice card was posted, so late taps can be answered. */
  const fileCards = new Map()
  /** chatId → an armed "type the instruction" choice. */
  const awaitingInstruction = new Map()
  const AWAIT_FILES_TTL_MS = 30 * 60 * 1000

  function stagedOf(chatId) {
    let entries = stagedFiles.get(chatId)
    if (!entries) {
      entries = new Map()
      stagedFiles.set(chatId, entries)
    }
    return entries
  }

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
      [NO_MODEL_FOOTER]: true,
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
      [NO_MODEL_FOOTER]: true,
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
      [NO_MODEL_FOOTER]: true,
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
      [NO_MODEL_FOOTER]: true,
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
      let attachmentMessageId = messageId
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

      // A card choice, a quoted file message, or a plain follow-up all count as
      // an instruction. Files clicked "什么也不做" only come back when quoted.
      const instruction = awaitingInstruction.get(chatId)
      let useInstruction = false
      if (instruction) {
        awaitingInstruction.delete(chatId)
        useInstruction = Date.now() - instruction.at <= AWAIT_FILES_TTL_MS
        if (!useInstruction) await reply(chatId, '之前的文件请求已超时，请重新发送文件。')
      }
      const quotedIds = quotedMessageIds(message)
      const quotedTexts = []
      // 插件重启后 stagedFiles 是空的；回复一条旧消息时只能按 ID 回查飞书，
      // 才能把旧消息里的文件、图片或正文一起交给 DSH。
      if (safeText && quotedIds.size > 0) {
        const stagedIds = new Set()
        const entries = stagedFiles.get(chatId)
        if (entries) {
          for (const entry of entries.values()) stagedIds.add(entry.messageId)
        }
        let refToken
        const missing = [...quotedIds].filter((id) => !stagedIds.has(id)).slice(0, 10)
        for (const id of missing) {
          try {
            refToken ||= await getTenantToken(state.appId, state.appSecret, state.domain)
            const original = await getMessage(refToken, state.domain, id)
            const parsed = contentOf(original)
            for (const ref of parsed.fileRefs) fileRefs.push({ ...ref, messageId: id })
            for (const key of parsed.imageKeys) imageKeys.push({ key, messageId: id })
            if (parsed.text) quotedTexts.push(parsed.text)
            trace?.('quoted-message-resolved', { id, files: parsed.fileRefs.length, images: parsed.imageKeys.length })
          } catch (error) {
            trace?.('quoted-message-fetch-failed', { id, message: String((error && error.message) || error).slice(0, 200) })
          }
        }
      }
      if (safeText && (useInstruction || quotedIds.size > 0 || stagedFiles.has(chatId))) {
        const entries = stagedFiles.get(chatId)
        if (entries) {
          for (const [fileId, entry] of entries) {
            const quoted = quotedIds.has(entry.messageId)
            const include = quoted
              || (useInstruction && entry.status !== 'noop')
              || (!useInstruction && quotedIds.size === 0 && entry.status === 'pending')
            if (include) {
              fileRefs.push(...entry.fileRefs)
              entries.delete(fileId)
              fileCards.delete(fileId)
            }
          }
          if (entries.size === 0) stagedFiles.delete(chatId)
        }
      }

      if (!state.allowCommands) {
        await reply(chatId, '在 DSH 设置里关闭了「允许在飞书里指挥」——现在只接收通知。')
        return
      }

      // A file without an instruction must not be sent to DSH as "please handle
      // this file". Ask what the user wants, and keep the refs for the next text.
      const captureArmed = Boolean(captures?.peek(chatId))
      if (!captureArmed && !text && fileRefs.length > 0) {
        const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const refs = fileRefs.map((ref) => ({ ...ref, messageId }))
        const names = refs.map((file) => file.name).join('、')
        stagedOf(chatId).set(id, { fileRefs: refs, messageId, at: Date.now(), status: 'pending' })
        fileCards.set(id, { chatId })
        const card = fileChoiceCard(id, names, chatId)
        if (postCard) await postCard(chatId, card)
        else await reply(chatId, `已收到文件：${names}。请点卡片选择下一步。`)
        trace?.('inbound-file-card', { id, count: refs.length })
        return
      }

      const commandToken = safeText.startsWith('/') ? safeText.split(/\s+/)[0].toLowerCase() : ''
      // 中文别名统一映射到英文指令；slice 时必须用原始 token 的长度。
      const commandAliases = {
        '/帮助': '/help',
        '/说明': '/help',
        '/会话': '/sessions',
        '/历史': '/sessions',
        '/切换会话': '/sessions',
        '/当前': '/id',
        '/绑定': '/id',
        '/current': '/id',
        '/新会话': '/new',
        '/新建': '/new',
        '/重启': '/restart',
        '/排队': '/queue',
        '/权限': '/permission',
        '/模式': '/permission',
        '/模型': '/model',
        '/停止': '/stop',
        '/停下': '/stop',
        '/编号': '/id',
        '/标识': '/id',
      }
      const command = commandAliases[commandToken] || commandToken

      // 专用触发词：返回一排会话按钮，点按钮即切换；不走 DSH prompt，
      // 也不占用 /sessions 的筛选语义，避免和普通指令冲突。
      if (safeText === '切换会话' || safeText === '/切换会话') {
        await showSessions(chatId, '')
        return
      }

      if (command === '/help') {
        const help = [
          '直接发消息即可（文本 / 图片 / 文件）。',
          '',
          '【会话】',
          '切换会话（/切换会话）：返回按钮列表，点一下即切换',
          '/sessions [关键字]（/会话、/历史）：列出会话并点按钮切换',
          '/id（/current、/编号）：会话详情、轮次、token、模型与权限',
          '',
          '【任务】',
          '/new（/新会话）：开一个新会话',
          '/queue <内容>（/排队）：排队处理（运行时默认插话）',
          '/stop（/停止）：停下当前会话',
          '',
          '【设置】',
          '/permission（/mode、/权限）：查看或切换权限模式',
          '/model（/模型）：查看或切换模型（注意付费）',
          '',
          '【系统】',
          '/restart（/重启）：重启 DSH（有任务在跑会拒绝）',
          '/help（/帮助）：本说明',
          '',
          '/resume 已停用，请改用会话按钮。',
        ].join('\n')
        if (postCard) {
          await postCard(chatId, blueTextCard(help, '使用说明'))
        } else {
          await reply(chatId, help)
        }
        return
      }

      if (command === '/sessions' || command === '/history') {
        await showSessions(chatId, safeText.slice(commandToken.length).trim())
        return
      }

      if (command === '/id') {
        const state0 = await readState()
        const boundId = state0.chatSessions?.[chatId]
        if (!boundId) {
          await reply(chatId, '这个对话还没绑定会话；发一句话就会自动开一个，或用 /sessions 选一个。')
          return
        }
        let label = ''
        try {
          const row = await sessions?.resolve?.(chatId, boundId)
          label = String(row?.label || row?.title || '')
        } catch {
          // 名称拿不到时只回 ID。
        }
        if (!label) {
          try {
            const live = typeof ctx.get === 'function' ? ctx.get('sessions')?.get?.(boundId) : undefined
            label = String(live?.projections?.values?.title || '')
          } catch {
            // 名称拿不到时只回 ID。
          }
        }
        const status = await sessionStatusText({
          ctx,
          sessions,
          models,
          permissions,
          readState,
          chatId,
          sessionId: boundId,
          label,
          state: state0,
        })
        // 长文本状态用蓝色卡片展示；无卡片通道时回退到纯文本。
        if (postCard) {
          await postCard(chatId, blueTextCard(`${status}\n继续发消息即可。`, '会话状态'))
        } else {
          await reply(chatId, `${status}\n继续发消息即可。`)
        }
        return
      }

      // /resume 已由会话按钮取代；保留提示，避免误把命令当正文发给 DSH。
      if (command === '/resume') {
        await reply(chatId, '/resume 已由会话按钮取代：发 /sessions 或「切换会话」，点按钮即可切换。')
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
        const argument = safeText.slice(commandToken.length).trim().toLowerCase()
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

      let body = command === '' ? safeText : safeText.slice(commandToken.length).trim()
      if (!body && imageKeys.length > 0) body = '请识别这张图片并描述内容。'
      if (!body && fileRefs.length > 0) {
        body = fileRefs.length === 1
          ? `请处理这个${fileRefs[0].folder ? '文件夹' : '文件'}：${fileRefs[0].name}`
          : `请处理这些附件：${fileRefs.map((file) => file.name).join('、')}`
      }
      if (!body) {
        await reply(chatId, '命令后面还需要内容，或者直接说要做的事。')
        return
      }
      if (quotedTexts.length > 0) {
        const context = quotedTexts.map((text) => `【引用的原消息】${text}`).join('\n\n')
        body = `${context}\n\n${body}`
      }

      // 粘贴的飞书消息链接目前无法用公开 API 反查成消息内容；至少把链接
      // 原文和可解析范围说明交给 DSH，避免模型以为用户什么都没发。
      const feishuLinks = extractFeishuLinks(safeText)
      if (feishuLinks.length > 0) {
        body = annotateFeishuLinks(body, feishuLinks)
        trace?.('inbound-feishu-links', { count: feishuLinks.length })
      }

      // Download images with the app token and stage files for the target
      // session before prompt admission. DSH accepts image bytes inline and
      // files by the opaque receipt returned from a same-session upload.
      const contentParts = [{ type: 'text', text: body }]
      const fileUploads = typeof ctx.get === 'function' ? ctx.get('fileUploads') : undefined
      if (imageKeys.length > 0 || fileRefs.length > 0) {
        try {
          const token = await getTenantToken(state.appId, state.appSecret, state.domain)
          for (const imageRef of imageKeys) {
            const key = typeof imageRef === 'string' ? imageRef : imageRef.key
            const sourceId = (typeof imageRef === 'string' ? messageId : imageRef.messageId) || messageId
            const image = await downloadImageResource(token, state.domain, sourceId, key)
            contentParts.push({ type: 'image', mediaType: image.mediaType, data: image.data, name: image.name })
          }
          trace?.('inbound-images', { count: imageKeys.length, bytes: contentParts.slice(1).reduce((sum, part) => sum + (part.data?.length || 0), 0) })
          let fileBytes = 0
          // 文件夹不能直接下载：先按原消息展开成真实文件，再走普通文件流程。
          const expandedRefs = []
          for (const fileRef of fileRefs) {
            if (fileRef.folder) {
              const sourceId = fileRef.messageId || attachmentMessageId
              const folder = await listFolderFiles(token, state.domain, fileRef.key, sourceId)
              trace?.('inbound-folder-expanded', { files: folder.files.length, name: fileRef.name })
              for (const file of folder.files) expandedRefs.push({ ...file, messageId: sourceId })
            } else {
              expandedRefs.push(fileRef)
            }
          }
          if (fileRefs.length > 0 && expandedRefs.length === 0) throw new Error('文件夹里没有可处理的文件')
          for (const fileRef of expandedRefs) {
            if (!fileUploads?.uploadStream) throw new Error('当前 DSH 版本不支持文件识别，请升级 Harness')
            const file = await downloadFileResource(token, state.domain, fileRef.messageId || attachmentMessageId, fileRef.key, fileRef.name)
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
          trace?.('inbound-files', { count: expandedRefs.length, bytes: fileBytes })
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

  /** 新版卡片回传交互要求 card 为 {type:'raw',data:<Card JSON>}，直接返回卡片会报 200672。 */
  function fileResponse(toast, card) {
    return card ? { toast, card: { type: 'raw', data: card } } : { toast }
  }

  async function handleCardAction(data) {
    const value = data?.action?.value
    if (!value || value.k !== 'filechoice') return undefined
    const id = String(value.id || '')
    const chatId = String(value.c || '')
    const entry = stagedFiles.get(chatId)?.get(id)
    if (!entry) return { toast: { type: 'warning', content: '这张文件卡片已失效。' } }
    const openId = String(data?.operator?.open_id || '')
    const state = await readState()
    if (openId && state.allowedOpenIds.length > 0 && !state.allowedOpenIds.includes(openId)) {
      return { toast: { type: 'warning', content: '你没有权限操作这个机器人。' } }
    }
    const names = entry.fileRefs.map((file) => file.name).join('、')
    if (value.v === 'noop') {
      entry.status = 'noop'
      fileCards.delete(id)
      trace?.('inbound-file-noop', { id })
      return fileResponse(
        { type: 'info', content: '已忽略。稍后在文字里引用这个文件，仍可一起处理。' },
        fileStateCard(names, 'noop'),
      )
    }
    if (value.v === 'input') {
      entry.status = 'input'
      fileCards.delete(id)
      awaitingInstruction.set(chatId, { at: Date.now(), id })
      trace?.('inbound-file-input', { id })
      return fileResponse(
        { type: 'info', content: '请在下一条消息里输入说明，可引用其他文件一起处理。' },
        fileStateCard(names, 'input'),
      )
    }
    return undefined
  }

  return { handle, handleCardAction, takeReply, takeTyping }
}
