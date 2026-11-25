/**
 * 从 DSH session/event 折叠出一条任务结束通知，并发到飞书 webhook。
 *
 * 只处理三类 durable 事件：turn/start 记时间、assistant/message 取最后正文、
 * turn/end 汇总发送。取消的轮次静默，子代理轮次跳过（由父会话统一汇报）。
 */
import { buildContentCards } from './card.js'
import { sendWebhookCard, sendWebhookText } from './webhook.js'

/** 正文兜底截断长度。 */
const MAX_BODY_CHARS = 1200

function sessionLabel(session) {
  const cwd = String(session?.header?.cwd || '')
  const base = cwd.split(/[\\/]/).filter(Boolean).pop() || 'session'
  const id = String(session?.id || '').replace(/^session-/, '')
  return `${base} · ${id.slice(0, 8)}`
}

function assistantText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function truncate(text, limit) {
  const value = String(text || '')
  if (!value || value.length <= limit) return value
  return `${value.slice(0, limit)}\n…（已截断，共 ${value.length} 字）`
}

function reasonLine(reason) {
  if (!reason || typeof reason !== 'object') return ''
  if (reason.kind === 'error') return `结束原因：出错（${reason.error?.message || reason.error?.code || '未知错误'}）`
  if (reason.kind === 'max-tokens') return '结束原因：达到 max-tokens 上限'
  return ''
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`
}

/** 组装一条结束通知（纯函数，便于单测）。 */
export function turnNotice({ session, reason, text, durationMs, label, maxChars = MAX_BODY_CHARS }) {
  const kind = reason?.kind
  const duration = Number.isFinite(durationMs) && durationMs > 0 ? formatDuration(durationMs) : ''
  const meta = [duration ? `**用时**：${duration}` : '', reasonLine(reason)].filter(Boolean)
  const body = truncate(text || '（这一轮没有文本输出）', maxChars)
  return {
    title: kind === 'completed' ? '✅ DSH 任务完成' : '⚠️ DSH 任务结束',
    template: kind === 'completed' ? 'green' : 'red',
    subtitle: label || sessionLabel(session),
    markdown: `${meta.length > 0 ? `${meta.join('\n')}\n\n---\n\n` : ''}${body}`,
    note: `来自 DSH · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
  }
}

/**
 * 创建通知器。
 * @param options.readState 读取当前配置
 * @param options.log 诊断日志
 * @param options.trace 可选埋点
 */
export function createNotifier({ readState, log = () => {}, trace, takeReply, sendChatCard }) {
  /** sessionId → 最后一段助手正文。 */
  const lastText = new Map()
  /** sessionId → turn/start 时间戳。 */
  const turnStart = new Map()

  async function deliver(notice, state, replyTarget) {
    if (!state) state = await readState()
    if (!state.notifyTurnEnd) return trace?.('skip', { reason: 'notify-off' })

    // 由飞书私聊发起的轮次，结果回到原对话；不重复发 webhook 强提醒。
    if (replyTarget && typeof sendChatCard === 'function') {
      const chatCards = buildContentCards({
        title: notice.title,
        template: notice.template,
        subtitle: notice.subtitle,
        markdown: notice.markdown,
        note: notice.note,
        tableMode: 'markdown',
        mentionAll: false,
      })
      for (let index = 0; index < chatCards.length; index += 1) {
        try {
          await sendChatCard(replyTarget.chatId, chatCards[index])
          trace?.('chat-card-sent', { parts: chatCards.length, chars: notice.markdown.length })
        } catch (error) {
          const message = String((error && error.message) || error).slice(0, 300)
          trace?.('chat-card-failed', { message })
          log(`[feishu-mcp] 回执卡片失败：${message}`)
        }
      }
      return
    }

    if (!state.webhookUrl) return trace?.('skip', { reason: 'no-webhook' })

    const cards = buildContentCards({
      title: notice.title,
      template: notice.template,
      subtitle: notice.subtitle,
      markdown: notice.markdown,
      note: notice.note,
      tableMode: 'markdown',
      mentionAll: state.webhookAtAll,
    })

    // 只发卡片：@all 已通过 mentionAll 合并进卡片正文，不再额外发文本消息。
    for (const card of cards) {
      try {
        await sendWebhookCard(state, card)
        trace?.('card-sent', { parts: cards.length, chars: notice.markdown.length })
      } catch (error) {
        const message = String((error && error.message) || error).slice(0, 300)
        trace?.('card-failed', { message })
        // 卡片被拒（客户端版本、webhook 安全策略等）时降级成纯文本，不能吞掉结果。
        const text = [notice.title, notice.subtitle, truncate(notice.markdown, 1500), notice.note].filter(Boolean).join('\n')
        try {
          await sendWebhookText(state, text)
          trace?.('text-fallback-sent', {})
        } catch (fallbackError) {
          log(`[feishu-mcp] 文本兜底也失败：${String((fallbackError && fallbackError.message) || fallbackError)}`)
        }
      }
    }
  }

  /** 喂入一条已提交的 session 事件；绝不向 session 循环抛错。 */
  async function onSessionEvent(session, event) {
    try {
      if (!event || !session) return
      const sessionId = String(session.id)
      if (session.header?.origin === 'subagent') return

      if (event.type === 'turn/start') {
        turnStart.set(sessionId, Date.now())
        lastText.delete(sessionId)
        return
      }

      if (event.type === 'assistant/message') {
        const text = assistantText(event.data?.message)
        if (text) lastText.set(sessionId, text)
        return
      }

      if (event.type !== 'turn/end') return

      const reason = event.data?.reason
      const kind = reason?.kind
      // 任何 turn/end 都把等待中的飞书回执消费掉，避免取消轮次留下悬挂项。
      const claimedReply = typeof takeReply === 'function' ? takeReply(sessionId) : undefined
      // 取消静默；只有完成、出错、达到上限才播报。
      if (kind !== 'completed' && kind !== 'error' && kind !== 'max-tokens') return

      const started = turnStart.get(sessionId)
      const state = await readState()
      const replyTarget = state.inboundReply === false ? undefined : claimedReply
      const notice = turnNotice({
        session,
        reason,
        text: lastText.get(sessionId) || '',
        durationMs: started ? Date.now() - started : 0,
        maxChars: state.maxChars,
      })

      void deliver(notice, state, replyTarget).catch((error) => {
        const message = String((error && error.message) || error)
        trace?.('deliver-failed', { message: message.slice(0, 200) })
        log(`[feishu-mcp] 通知发送失败：${message}`)
      })
    } catch (error) {
      log(`[feishu-mcp] notifier 异常：${String((error && error.message) || error)}`)
    }
  }

  return { onSessionEvent, deliver, turnNotice }
}
