/**
 * Host 端：飞书结束通知插件（出站阶段）。
 *
 * 只做两件事：
 * 1. 订阅 session/event，在 turn/end 时把结果推到飞书自定义机器人 webhook；
 * 2. 注册精确 Fetch 路由，让设置页能读写配置并做连通性测试。
 *
 * 入站私聊监听订阅暂不启用，等下一阶段再接。
 */
import { buildContentCards } from './lib/card.js'
import { createNotifier } from './lib/notifier.js'
import { clearState, publicState, readState, writeState } from './lib/state.js'
import { sendWebhookAtAll, sendWebhookCard } from './lib/webhook.js'

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

export function apply(ctx) {
  const warn = (message) => {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  }
  const log = (message) => {
    if (typeof ctx.logger?.info === 'function') ctx.logger.info(message)
    else console.info(message)
  }

  const notifier = createNotifier({
    readState,
    log,
    trace: (kind, data) => {
      void readState()
        .then((state) => { if (state.trace) log(`[${PLUGIN_NAME}] trace ${kind}: ${JSON.stringify(data)}`) })
        .catch(() => {})
    },
  })

  // 参考实现：直接注册，不放进 ctx.effect —— fork scope 的事件 lineage
  // 不一定包含被观察的 session，effect 生命周期会漏掉事件。
  ctx.on('session/event', (session, event) => notifier.onSessionEvent(session, event))

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
        const next = {
          ...current,
          // 表单里留空表示保留已配置的地址，避免掩码展示被误存成空值。
          webhookUrl: providedWebhook || current.webhookUrl,
          webhookAtAll: asBool(body.webhookAtAll, current.webhookAtAll),
          notifyTurnEnd: asBool(body.notifyTurnEnd, current.notifyTurnEnd),
          cardTitle: asString(body.cardTitle, current.cardTitle),
          maxChars: asPositiveInt(body.maxChars, current.maxChars),
          trace: asBool(body.trace, current.trace),
          updatedAt: Date.now(),
        }
        if (next.webhookUrl && !/^https?:\/\//i.test(next.webhookUrl)) {
          throw new Error('webhook 地址必须以 http:// 或 https:// 开头')
        }
        if (next.maxChars > 20000) throw new Error('maxChars 不能大于 20000')
        const saved = await writeState(next)
        return json({ ok: true, state: publicState(saved) })
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
          mentionAll: false,
        })
        const results = []
        if (state.webhookAtAll) {
          try {
            await sendWebhookAtAll(state, `${state.cardTitle || 'DSH 任务结束提醒'}\n连通性测试：飞书通知插件已连通。`)
            results.push({ stage: 'at-all', ok: true })
          } catch (error) {
            results.push({ stage: 'at-all', ok: false, message: String((error && error.message) || error) })
          }
        }
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
      path: `${API}/clear`,
      methods: ['POST'],
      async handler() {
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
