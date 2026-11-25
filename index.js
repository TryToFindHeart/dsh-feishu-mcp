/**
 * Host 端：飞书结束通知 + 私聊入站插件。
 *
 * 出站：订阅 session/event，在 turn/end 把结果推到群自定义机器人 webhook；
 * 入站：企业自建应用机器人通过 WebSocket 长连接接收私聊，把文本送进 DSH。
 * 设置页只经 /api/feishu-mcp/* 精确路由读写配置，浏览器不接触任何密钥。
 */
import { buildContentCards } from './lib/card.js'
import {
  forgetTenantToken,
  getBotInfo,
  getTenantToken,
  sendMessage,
  sendText,
} from './lib/feishu.js'
import { createGateway } from './lib/gateway.js'
import { createInbound } from './lib/inbound.js'
import { createNotifier } from './lib/notifier.js'
import { createSessions } from './lib/sessions.js'
import { clearState, publicState, readState, writeState } from './lib/state.js'
import { sendWebhookCard } from './lib/webhook.js'

/** 路由必须挂在 /api 下，connection.fetch.register 会做路径校验。 */
const API = '/api/feishu-mcp'
const PLUGIN_NAME = 'dsh-feishu-mcp'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

async function readJsonBody(request) {
  const text = await request.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法的 JSON')
  }
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function asBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null) return fallback
  return Boolean(value)
}

function asPositiveInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

function asStringList(value, fallback) {
  if (value === undefined || value === null) return fallback
  const values = Array.isArray(value) ? value : String(value).split(/[,，\n]/)
  return values.map((item) => String(item).trim()).filter(Boolean)
}

export function apply(ctx) {
  const warn = (message) => {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  }
  const log = (message) => {
    if (typeof ctx.logger?.info === 'function') ctx.logger.info(message)
    else console.info(message)
  }
  const trace = (kind, data) => {
    void readState()
      .then((state) => { if (state.trace) log(`[${PLUGIN_NAME}] trace ${kind}: ${JSON.stringify(data)}`) })
      .catch(() => {})
  }

  const sessions = createSessions({ ctx, readState, writeState, trace })

  /** 入站回执：只通过应用机器人 API，不把凭据交给浏览器。 */
  async function appToken(state) {
    if (!state.appId || !state.appSecret) throw new Error('飞书应用 App ID / App Secret 未配置')
    return getTenantToken(state.appId, state.appSecret, state.domain)
  }

  async function replyText(chatId, text) {
    const state = await readState()
    if (!state.enableInbound) return
    const token = await appToken(state)
    await sendText(token, state.domain, { receiveId: chatId, receiveIdType: 'chat_id', text })
  }

  async function sendChatCard(chatId, card) {
    const state = await readState()
    const token = await appToken(state)
    await sendMessage(token, state.domain, {
      receiveId: chatId,
      receiveIdType: 'chat_id',
      msgType: 'interactive',
      content: card,
    })
  }

  const inbound = createInbound({ ctx, readState, writeState, replyText, log, trace, sessions })
  const gateway = createGateway({ inbound, log, trace })
  const notifier = createNotifier({
    readState,
    log,
    trace,
    takeReply: inbound.takeReply,
    sendChatCard,
  })

  // 参考实现：直接注册，不放进 ctx.effect —— fork scope 的事件 lineage
  // 不一定包含被观察的 session，effect 生命周期会漏掉事件。
  ctx.on('session/event', (session, event) => notifier.onSessionEvent(session, event))

  async function syncGateway() {
    try {
      await gateway.ensure(await readState())
    } catch (error) {
      warn(`[${PLUGIN_NAME}] 长连接未启动：${String((error && error.message) || error)}`)
    }
  }

  // 延迟到插件激活完成后再连，避免 application 阶段阻塞。
  const syncTimer = setTimeout(syncGateway, 0)
  ctx.effect(() => () => {
    if (syncTimer) clearTimeout(syncTimer)
    return gateway.stop()
  }, `${PLUGIN_NAME}: gateway`)

  const routes = [
    {
      path: `${API}/state`,
      methods: ['GET'],
      async handler() {
        return json({ state: publicState(await readState()) })
      },
    },
    {
      path: `${API}/config`,
      methods: ['POST'],
      async handler(request) {
        const body = await readJsonBody(request)
        const current = await readState()
        const providedWebhook = asString(body.webhookUrl, '')
        const providedAppSecret = asString(body.appSecret, '')
        const domain = asString(body.domain, current.domain).toLowerCase() === 'lark' ? 'lark' : 'feishu'
        const requestedMode = asString(body.sessionMode, current.sessionMode)
        const sessionMode = ['fixed', 'perChat', 'active'].includes(requestedMode) ? requestedMode : current.sessionMode

        const next = {
          ...current,
          // 表单留空表示保留已配置的值，避免掩码被误存成空值。
          webhookUrl: providedWebhook || current.webhookUrl,
          webhookAtAll: asBool(body.webhookAtAll, current.webhookAtAll),
          notifyTurnEnd: asBool(body.notifyTurnEnd, current.notifyTurnEnd),
          cardTitle: asString(body.cardTitle, current.cardTitle),
          maxChars: asPositiveInt(body.maxChars, current.maxChars),
          appId: asString(body.appId, current.appId) || current.appId,
          appSecret: providedAppSecret || current.appSecret,
          domain,
          enableInbound: asBool(body.enableInbound, current.enableInbound),
          allowedOpenIds: asStringList(body.allowedOpenIds, current.allowedOpenIds),
          sessionCwd: asString(body.sessionCwd, current.sessionCwd),
          workspaceTitle: asString(body.workspaceTitle, current.workspaceTitle),
          allowCommands: asBool(body.allowCommands, current.allowCommands),
          inboundReply: asBool(body.inboundReply, current.inboundReply),
          sessionMode,
        }

        if (next.webhookUrl && !/^https?:\/\//i.test(next.webhookUrl)) {
          throw new Error('webhook 地址必须以 http:// 或 https:// 开头')
        }
        if (next.maxChars > 8000) throw new Error('maxChars 不能大于 8000')
        if (next.enableInbound && (!next.appId || !next.appSecret)) {
          throw new Error('启用入站前请填写飞书应用的 App ID 和 App Secret')
        }

        // 凭据变了就丢掉旧 token，并让长连接按新配置重连。
        if (providedAppSecret || next.appId !== current.appId || next.domain !== current.domain) {
          forgetTenantToken(current.appId, current.domain)
        }
        const saved = await writeState(next)
        void syncGateway()
        return json({ ok: true, state: publicState(saved) })
      },
    },
    {
      path: `${API}/verify`,
      methods: ['POST'],
      async handler() {
        const body = await readJsonBody(request)
        const state = await readState()
        const appId = asString(body.appId, state.appId)
        const appSecret = asString(body.appSecret, state.appSecret) || state.appSecret
        if (!appId || !appSecret) throw new Error('请先填写 App ID 和 App Secret 并保存')
        const token = await getTenantToken(appId, appSecret, state.domain)
        const bot = await getBotInfo(token, state.domain)
        await syncGateway()
        return json({ ok: true, botName: bot.name, botOpenId: bot.openId })
      },
    },
    {
      path: `${API}/test`,
      methods: ['POST'],
      async handler() {
        const state = await readState()
        if (!state.webhookUrl) throw new Error('请先在设置页填写飞书 webhook 地址')
        const cards = buildContentCards({
          title: state.cardTitle || 'DSH 任务结束提醒',
          template: 'blue',
          subtitle: '连通性测试',
          markdown: [
            '**这是一条来自 DSH 飞书通知插件的测试消息。**',
            '',
            '- 如果你看到这条卡片，说明出站 webhook 已连通。',
            '- 之后每一轮任务结束都会在这里收到一张结果卡片。',
          ].join('\n'),
          note: `测试时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
          mentionAll: state.webhookAtAll,
        })
        const results = []
        for (let index = 0; index < cards.length; index += 1) {
          try {
            await sendWebhookCard(state, cards[index])
            results.push({ stage: `card-${index + 1}`, ok: true })
          } catch (error) {
            results.push({ stage: `card-${index + 1}`, ok: false, message: String((error && error.message) || error) })
          }
        }
        const failed = results.filter((item) => !item.ok)
        if (failed.length > 0) return json({ ok: false, results }, 400)
        return json({ ok: true, results })
      },
    },
    {
      path: `${API}/disconnect`,
      methods: ['POST'],
      async handler() {
        const state = await readState()
        forgetTenantToken(state.appId, state.domain)
        await gateway.stop()
        const saved = await writeState({
          ...state,
          appId: '',
          appSecret: '',
          enableInbound: false,
          allowedOpenIds: [],
          chatSessions: {},
        })
        return json({ ok: true, state: publicState(saved) })
      },
    },
    {
      path: `${API}/clear`,
      methods: ['POST'],
      async handler() {
        const state = await readState()
        forgetTenantToken(state.appId, state.domain)
        await gateway.stop()
        await clearState()
        return json({ ok: true, state: publicState(await readState()) })
      },
    },
  ]

  ctx.inject(['connection'], (scope) => {
    const connection = scope.connection
    if (!connection || typeof connection.fetch?.register !== 'function') {
      warn(`[${PLUGIN_NAME}] connection.fetch 不可用，设置页无法读写配置`)
      return
    }
    for (const route of routes) {
      try {
        scope.effect(
          () => connection.fetch.register({
            path: route.path,
            methods: route.methods,
            requestBody: 'buffered',
            fetch: async (request) => {
              try {
                return await route.handler(request)
              } catch (error) {
                const message = String((error && error.message) || error)
                warn(`[${PLUGIN_NAME}] ${request.method} ${route.path}: ${message}`)
                return json({ error: message }, 400)
              }
            },
          }),
          `${PLUGIN_NAME}: ${route.path}`,
        )
      } catch (error) {
        warn(`[${PLUGIN_NAME}] 无法注册 ${route.path}：${String((error && error.message) || error)}`)
      }
    }
  })
}
