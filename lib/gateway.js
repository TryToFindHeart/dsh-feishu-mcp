/**
 * 飞书应用机器人长连接生命周期。
 *
 * WebSocket 的重连由飞书 Node SDK 负责；这里只负责在凭据或开关变化时
 * 启动/停止连接。消息语义不在这一层处理，全部交给 lib/inbound.js。
 */
export function createGateway({ inbound, log, trace }) {
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
      // force: 凭据变化时必须立刻断开旧应用，不能等 SDK 的优雅握手超时。
      await current.client.close({ force: true })
      trace?.('gateway-stopped', {})
    } catch (error) {
      trace?.('gateway-stop-failed', { message: String((error && error.message) || error) })
    }
  }

  async function start(state) {
    let sdk
    try {
      sdk = await import('@larksuiteoapi/node-sdk')
    } catch (error) {
      throw new Error(`缺少 @larksuiteoapi/node-sdk，请在插件目录执行 npm install：${String((error && error.message) || error)}`)
    }

    const dispatcher = new sdk.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => inbound.handle(data),
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
        // 失败不能缓存为“运行中”，下一次配置保存会重试。
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
