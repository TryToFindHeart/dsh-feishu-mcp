/**
 * 飞书应用机器人的最小 API 封装。
 *
 * 只保留入站转发和回执需要的四件事：tenant token、机器人身份、发消息、发卡片。
 * 不依赖 SDK 的 HTTP 层，便于单测替换 globalThis.fetch；WebSocket 仍由
 * @larksuiteoapi/node-sdk 在 lib/gateway.js 中负责。
 */

const tokenCache = new Map()

/** 规范化飞书域名。 */
export function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase() === 'lark' ? 'lark' : 'feishu'
}

function openBase(domain) {
  return normalizeDomain(domain) === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
}

function timeoutSignal(timeoutMs = 15000) {
  return typeof AbortSignal?.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined
}

export class FeishuError extends Error {
  constructor(message, { code, status } = {}) {
    super(message)
    this.name = 'FeishuError'
    this.code = code
    this.status = status
  }
}

async function readJson(response) {
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text || '{}')
  } catch {
    throw new FeishuError(`飞书返回了非 JSON 响应（HTTP ${response.status}）`, { status: response.status })
  }
  if (!response.ok) {
    throw new FeishuError(`飞书 HTTP ${response.status}：${data.msg || text.slice(0, 120)}`, {
      code: data.code,
      status: response.status,
    })
  }
  return data
}

/** 获取并缓存 tenant_access_token，提前 60 秒刷新。 */
export async function getTenantToken(appId, appSecret, domain = 'feishu') {
  const normalized = normalizeDomain(domain)
  const key = `${normalized}:${appId}`
  const cached = tokenCache.get(key)
  if (cached && cached.expireAt > Date.now() + 60_000) return cached.token

  const response = await fetch(`${openBase(normalized)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: timeoutSignal(),
  })
  const data = await readJson(response)
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new FeishuError(`App ID / App Secret 校验失败：${data.msg || `code=${data.code}`}`, { code: data.code })
  }
  const token = String(data.tenant_access_token)
  tokenCache.set(key, {
    token,
    expireAt: Date.now() + Math.max(60, Number(data.expire) || 7200) * 1000,
  })
  return token
}

/** 凭据变更或断开时清掉缓存。 */
export function forgetTenantToken(appId, domain = 'feishu') {
  tokenCache.delete(`${normalizeDomain(domain)}:${appId}`)
}

/** 读取机器人名称与 open_id，用来验证凭据。 */
export async function getBotInfo(token, domain = 'feishu') {
  const response = await fetch(`${openBase(domain)}/open-apis/bot/v3/info`, {
    headers: { authorization: `Bearer ${token}` },
    signal: timeoutSignal(),
  })
  const data = await readJson(response)
  if (data.code !== 0) {
    throw new FeishuError(`读取机器人信息失败：${data.msg || `code=${data.code}`}`, { code: data.code })
  }
  const bot = data.bot || data?.data?.bot || {}
  return { name: String(bot.app_name || bot.bot_name || ''), openId: String(bot.open_id || '') }
}

/** 通过应用机器人发一条消息。content 由调用方给出 JSON 对象。 */
export async function sendMessage(token, domain, { receiveId, receiveIdType = 'chat_id', msgType, content }) {
  const response = await fetch(
    `${openBase(domain)}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: msgType,
        content: typeof content === 'string' ? content : JSON.stringify(content),
      }),
      signal: timeoutSignal(),
    },
  )
  const data = await readJson(response)
  if (data.code !== 0) {
    throw new FeishuError(`发送飞书消息失败：${data.msg || `code=${data.code}`}`, { code: data.code })
  }
  return { messageId: String(data?.data?.message_id || '') }
}

/** 发送纯文本回执。 */
export async function sendText(token, domain, { receiveId, receiveIdType = 'chat_id', text }) {
  return sendMessage(token, domain, {
    receiveId,
    receiveIdType,
    msgType: 'text',
    content: { text: String(text || '') },
  })
}
