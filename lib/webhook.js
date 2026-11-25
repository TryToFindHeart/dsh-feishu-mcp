/**
 * 飞书自定义机器人 webhook 出站。
 *
 * 自定义机器人 webhook 只能发消息、不能收消息；本模块只负责把 DSH 的
 * 卡片/文本 POST 到用户配置的 webhook 地址。密钥只从 state 里读取，
 * 不会进入日志或浏览器。
 */

/** 发起一次 webhook 请求并校验飞书返回码。 */
export async function sendWebhook(url, body, timeoutMs = 10000) {
  if (!url || typeof url !== 'string') throw new Error('尚未配置飞书 webhook 地址')
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = String((error && error.message) || error)
    throw new Error(`飞书 webhook 请求失败：${message}`)
  }

  const text = await response.text().catch(() => '')
  let payload = {}
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: text.slice(0, 200) }
    }
  }

  // 飞书不同入口的返回字段略有差异：自定义机器人常见 code/msg，
  // 也有的入口返回 StatusCode/StatusMessage。两者都按 0 为成功。
  const code = payload.code ?? payload.StatusCode ?? payload.status ?? 0
  if (!response.ok || Number(code) !== 0) {
    const detail = payload.msg || payload.StatusMessage || payload.raw || ''
    throw new Error(`飞书 webhook 返回失败：HTTP ${response.status}，code=${code}${detail ? `，msg=${detail}` : ''}`)
  }
  return payload
}

/** 发送 interactive 卡片。 */
export function sendWebhookCard(state, card) {
  return sendWebhook(state.webhookUrl, { msg_type: 'interactive', card })
}

/** 发送纯文本。 */
export function sendWebhookText(state, text) {
  return sendWebhook(state.webhookUrl, { msg_type: 'text', content: { text } })
}

/** 发送带 @all 的文本强提醒（卡片可能被折叠时的兜底）。 */
export function sendWebhookAtAll(state, text) {
  return sendWebhook(state.webhookUrl, {
    msg_type: 'text',
    content: { text },
    at: { isAtAll: true },
  })
}
