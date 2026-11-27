/**
 * 飞书 → DSH：把私聊消息送进会话，并记住由哪个飞书对话在等结果。
 *
 * Feishu 会重发事件，所以用 message_id 去重；送进 DSH 时把同一个
 * message_id 作为 requestId，重试就变成一次幂等提交。结果不在这里回写，
 * 而是由 notifier 在 turn/end 时通过 takeReply 找到原对话回卡片。
 */

import { mkdir } from 'node:fs/promises'

import { sendText } from './feishu.js'
import { expandHome } from './sessions.js'

const MAX_SEEN = 500

/** 解析文本消息并剔除 @提及。 */
export function textOf(message) {
  if (message?.message_type !== 'text') return null
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

function isBotSender(data) {
  const sender = data?.sender || {}
  return sender.sender_type === 'app' || sender.sender_type === 'bot'
}

/** 运行中默认插话，排队需显式 /queue。 */
export function deliveryMode(busy, wantsQueue = false) {
  return busy && !wantsQueue ? 'steer' : 'queue'
}

export function createInbound({ ctx, readState, writeState, replyText, log, trace, sessions }) {
  const seen = new Set()
  const seenOrder = []
  /** sessionId → 等待结果的飞书对话。 */
  const pending = new Map()

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

  function service(name) {
    const value = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (value === undefined) throw new Error(`Host 服务 ${name} 不可用`)
    return value
  }

  function takeReply(sessionId) {
    const key = String(sessionId)
    const entry = pending.get(key)
    if (entry === undefined) return undefined
    pending.delete(key)
    return entry
  }

  async function reply(chatId, text) {
    try {
      await replyText(chatId, text)
    } catch (error) {
      trace?.('reply-failed', { message: String((error && error.message) || error).slice(0, 200) })
    }
  }

  /** 通过应用机器人发卡片（设置页与入站共用同一条 API 路径）。 */
  async function postCard(chatId, card) {
    const state = await readState()
    const { getTenantToken, sendMessage } = await import('./feishu.js')
    const token = await getTenantToken(state.appId, state.appSecret, state.domain)
    return sendMessage(token, state.domain, {
      receiveId: chatId,
      receiveIdType: 'chat_id',
      msgType: 'interactive',
      content: card,
    })
  }

  async function newSession() {
    const state = await readState()
    const cwd = expandHome(state.sessionCwd) || process.cwd()
    try {
      await mkdir(cwd, { recursive: true })
    } catch (error) {
      trace?.('session-cwd-failed', { cwd, message: String((error && error.message) || error) })
    }
    const workspace = await sessions?.ensureWorkspace?.(cwd, state.workspaceTitle)
    const request = workspace?.id ? { workspaceId: workspace.id } : { cwd }
    const created = await service('sessionController').create(request)
    trace?.('session-created', { workspace: workspace?.id ? 'attached' : 'cwd-only' })
    return String(created.sessionId)
  }

  /** “当前会话”模式：跟随 DSH 里正在看的会话。 */
  async function activeSessionId() {
    const controller = service('sessionController')
    if (typeof controller.current !== 'function') return ''
    const current = await controller.current()
    return String(current?.sessionId || current?.id || '')
  }

  async function ensureSession(chatId, state) {
    let sessionId = ''
    let bindingKey = chatId

    if (state.sessionMode === 'fixed' && state.homeChatId) {
      bindingKey = state.homeChatId
      sessionId = state.chatSessions?.[bindingKey]
    } else if (state.sessionMode === 'active') {
      sessionId = await activeSessionId().catch(() => '')
    } else {
      sessionId = state.chatSessions?.[chatId]
    }

    if (sessionId) return sessionId
    sessionId = await newSession()
    await writeState({
      ...state,
      chatSessions: { ...(state.chatSessions || {}), [bindingKey]: sessionId },
      homeChatId: state.homeChatId || chatId,
    })
    return sessionId
  }

  async function showSessions(chatId, query) {
    if (!sessions) return reply(chatId, '会话列表不可用。')
    let rows
    try {
      rows = await sessions.list({ query, limit: 10 })
    } catch (error) {
      return reply(chatId, `读取会话失败：${String((error && error.message) || error)}`)
    }
    sessions.remember(chatId, rows)
    const currentId = await sessions.current(chatId)
    await reply(chatId, sessions.format(rows, currentId))
  }

  async function handle(data) {
    let chatId = ''
    try {
      if (!data?.message || isBotSender(data)) return

      const message = data.message
      const messageId = String(message.message_id || '')
      if (!messageId || !markSeen(messageId)) return
      // 需求明确是私聊；群聊不接管，避免打扰既有群机器人。
      if (message.chat_type !== 'p2p') return

      chatId = String(message.chat_id || '')
      const openId = String(data.sender?.sender_id?.open_id || '')
      if (!chatId) return

      const state = await readState()
      if (!state.enableInbound || !state.appId || !state.appSecret) return

      const text = textOf(message)
      if (!text) {
        await reply(chatId, '目前只处理文本消息。')
        return
      }

      const allowlist = state.allowedOpenIds || []
      if (!allowlist.includes(openId)) {
        if (allowlist.length > 0) {
          trace?.('inbound-denied', { openId: openId.slice(0, 8) })
          return
        }
        // 没有白名单时认领第一个联系机器人的人，随后锁定。
        const saved = await writeState({
          ...state,
          allowedOpenIds: [openId],
          ownerOpenId: state.ownerOpenId || openId,
        })
        state.allowedOpenIds = saved.allowedOpenIds
        state.ownerOpenId = saved.ownerOpenId
        trace?.('inbound-claimed', { openId: openId.slice(0, 8) })
        await reply(chatId, '已把你设为这个机器人的唯一使用者。之后的私聊都会转给 DSH。')
      }

      if (state.allowCommands === false) {
        await reply(chatId, '在 DSH 设置里关闭了「允许在飞书里指挥」——现在只接收通知。')
        return
      }

      const command = text.startsWith('/') ? text.split(/\s+/)[0].toLowerCase() : ''

      if (command === '/help') {
        await reply(chatId, [
          '直接把要做的事发给我就行；另外支持：',
          '/sessions [关键字] 列出会话',
          '/resume <编号|id|标题> 切换当前会话',
          '/current 看当前绑定',
          '/new 开一个新会话',
          '/queue <内容> 排队处理（默认会插话）',
          '/stop 让当前会话停下',
          '/id 看当前会话 id 与名称',
          '/help 这条说明',
        ].join('\n'))
        return
      }

      if (command === '/sessions') {
        await showSessions(chatId, text.slice(command.length).trim())
        return
      }

      if (command === '/current') {
        const sessionId = await sessions.current(chatId)
        await reply(chatId, sessionId
          ? `当前会话：${sessionId}\n继续发消息即可。`
          : '这个对话还没绑定会话；发一句话就会自动开一个。')
        return
      }

      if (command === '/id') {
        const sessionId = await sessions.current(chatId)
        if (!sessionId) {
          await reply(chatId, '这个对话还没绑定会话。')
          return
        }
        let label = ''
        try {
          const row = await sessions.resolve(chatId, sessionId)
          label = String(row?.label || row?.title || '')
        } catch {
          // 名称拿不到时只回 ID，不影响命令本身。
        }
        await reply(chatId, label ? `会话名称：${label}\n会话 ID：${sessionId}` : `会话 ID：${sessionId}`)
        return
      }

      if (command === '/resume') {
        const ref = text.slice(command.length).trim()
        if (!ref) {
          await reply(chatId, '用法：/resume <编号|id|标题>；先发 /sessions 看列表。')
          return
        }
        try {
          const row = await sessions.resolve(chatId, ref)
          await sessions.switchTo(chatId, row)
          await reply(chatId, `已切换到「${row.label}」。\n接下来的消息都会发给这个会话。`)
        } catch (error) {
          await reply(chatId, `切换失败：${String((error && error.message) || error)}`)
        }
        return
      }

      if (command === '/stop') {
        const sessionId = await sessions.current(chatId)
        const agent = sessionId && typeof ctx.get === 'function' ? ctx.get('agents')?.get?.(sessionId) : undefined
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

      const body = command === '' ? text : text.slice(command.length).trim()
      if (!body) {
        await reply(chatId, '命令后面还需要内容，或者直接说要做的事。')
        return
      }

      const sessionId = await ensureSession(chatId, await readState())
      const agent = typeof ctx.get === 'function' ? ctx.get('agents')?.get?.(sessionId) : undefined
      const busy = agent?.status === 'running'
      const wantsQueue = command === '/queue'
      const mode = deliveryMode(busy, wantsQueue)
      trace?.('inbound-prompt', { session: sessionId.slice(0, 12), chars: body.length, busy, mode })

      pending.set(sessionId, { chatId, messageId, at: Date.now() })
      try {
        await service('sessionController').prompt(
          {
            requestId: `feishu:${messageId}`,
            sessionId,
            mode,
            content: [{ type: 'text', text: body }],
          },
          AbortSignal.timeout(30_000),
        )
        if (mode === 'steer') {
          await reply(chatId, '⚡ 已插话：这条会作为当前这一轮的补充指令。\n想排队处理，就在前面加 /queue。')
        }
      } catch (error) {
        pending.delete(sessionId)
        const message = String((error && error.message) || error)
        // 插话不被接受时回退成排队，避免消息丢失。
        if (mode === 'steer' && /steer-unavailable|no longer accepts steering/i.test(message)) {
          try {
            await service('sessionController').prompt(
              {
                requestId: `feishu:${messageId}`,
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: body }],
              },
              AbortSignal.timeout(30_000),
            )
            pending.set(sessionId, { chatId, messageId, at: Date.now() })
            await reply(chatId, '这一轮现在不接受插话，已改成排队处理。')
            return
          } catch (retryError) {
            trace?.('inbound-queue-failed', {
              message: String((retryError && retryError.message) || retryError).slice(0, 160),
            })
          }
        }
        trace?.('inbound-failed', { message: message.slice(0, 200) })
        await reply(chatId, `没能把消息交给 DSH：${message}`)
      }
    } catch (error) {
      const message = String((error && error.message) || error)
      log(`[feishu-mcp] 入站处理失败：${message}`)
      trace?.('inbound-error', { message: message.slice(0, 200) })
      if (chatId) await reply(chatId, `DSH 处理这条消息时出错了：${message}`).catch(() => {})
    }
  }

  return { handle, takeReply, postCard }
}
