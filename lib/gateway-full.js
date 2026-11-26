/**
 * 飞书应用机器人长连接生命周期。
 *
 * WebSocket 的重连由飞书 Node SDK 负责；这里只负责在凭据或开关变化时
 * 启动或停止连接。消息语义不在这一层处理，全部交给 lib/inbound-full.js。
 */
import {
  FSMCP_EVENT_CARD_ACTION,
  FSMCP_EVENT_MESSAGE_RECEIVE,
} from './constants.js'

export function createGateway({ inbound, cardAction, log, trace }) {
  /** @type {{ key: string, client: any } | null} */
  let running = null
  let pendingStart = null

  function keyOf(state) {
    return `${state.domain}:${state.appId}:${state.appSecret}:${state.enableInbound ? 1 : 0}`
  }

  async function stop() {
    const current = running
    running = null
    if (!current) return
    try {
      // 凭据变化或入站关闭时必须立即断开旧应用，不能等 SDK 的优雅握手超时。
      await current.client.close({ force: true })
      trace?.('gateway-stopped', {})
    } catch (error) {
      trace?.('gateway-stop-failed', { message: String((error && error.message) || error) })
    }
  }

  async function start(state) {
    const sdk = await import('@larksuiteoapi/node-sdk')
    const dispatcher = new sdk.EventDispatcher({}).register({
      [FSMCP_EVENT_MESSAGE_RECEIVE]: (data) => inbound.handle(data),
      [FSMCP_EVENT_CARD_ACTION]: (data) => cardAction?.(data),
    })

    const client = new sdk.WSClient({
      appId: state.appId,
      appSecret: state.appSecret,
      domain: state.domain === 'lark' ? sdk.Domain.Lark : sdk.Domain.Feishu,
      loggerLevel: sdk.LoggerLevel.warn,
      onReady: () => trace?.('gateway-ready', {}),
      onError: (error) => trace?.('gateway-error', { message: String((error && error.message) || error) }),
      onReconnecting: () => trace?.('gateway-reconnecting', {}),
    })

    trace?.('gateway-connecting', { domain: state.domain })
    await client.start({ eventDispatcher: dispatcher })
    running = { key: keyOf(state), client }
    trace?.('gateway-started', { domain: state.domain })
  }

  /** 让长连接与当前配置保持一致。 */
  async function ensure(state) {
    if (!state.enableInbound || !state.appId || !state.appSecret) {
      await stop()
      return
    }
    if (running && running.key === keyOf(state)) return
    if (pendingStart === keyOf(state)) return pendingStart
    pendingStart = (async () => {
      try {
        await stop()
        await start(state)
      } catch (error) {
        const message = String((error && error.message) || error)
        log(`[feishu-mcp] 长连接启动失败：${message}`)
        trace?.('gateway-failed', { message: message.slice(0, 300) })
        // 启动失败不能缓存为 running，下一次配置变化或草稿保存要能重试。
        running = null
        throw error
      } finally {
        pendingStart = null
      }
    })()
    return pendingStart
  }

  return { ensure, stop }
}
