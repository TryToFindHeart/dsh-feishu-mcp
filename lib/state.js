/**
 * 插件的持久化状态。
 *
 * webhook URL、App Secret 都是密钥（谁拿到都能往飞书发消息），所以不写进
 * cordis.patch.yml，也不放进普通 Config。这里用 `$DSH_HOME/dsh-feishu-mcp/state.json`，
 * 权限 0600，原子替换写入。字段是“出站 webhook”与“参考插件增强能力”的合集。
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VERSION = 3

/** 状态文件所在目录。 */
function stateDir() {
  const home = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  return join(home, 'dsh-feishu-mcp')
}

/** 状态文件绝对路径。 */
export function stateFile() {
  return join(stateDir(), 'state.json')
}

/** 所有读取都会合并到这份默认值上。 */
const DEFAULTS = {
  version: VERSION,
  // 出站：自定义机器人 webhook（强提醒）。
  webhookUrl: '',
  enableWebhook: true,
  webhookAtAll: true,
  notifyTurnEnd: true,
  cardTitle: 'DSH 任务结束提醒',
  maxChars: 1200,
  // 入站：企业自建应用机器人（WebSocket 长连接）。
  appId: '',
  appSecret: '',
  domain: 'feishu',
  enableInbound: false,
  allowedOpenIds: [],
  ownerOpenId: '',
  homeChatId: '',
  botName: '',
  botOpenId: '',
  onboardedAt: 0,
  sessionMode: 'perChat',
  sessionCwd: '~/dsh-feishu-mcp',
  workspaceTitle: '飞书 DSH',
  allowCommands: true,
  inboundReply: true,
  // 关闭 Webhook 后，是否跟随通知静默切换会话（下一条消息回到通知所属会话）。
  followNoticeSwitch: true,
  lastNoticeSessionId: '',
  lastNoticeAt: 0,
  awayMode: false,
  // 一个飞书私聊对话绑定一个 DSH 会话。
  chatSessions: {},
  // 审批 / 提问卡片。
  notify: { turnEnd: true, approval: true, question: true },
  defaultPermission: 'workspace',
  chatPermissions: {},
  answerMode: 'feishu',
  answerTimeoutMinutes: 5,
  trace: false,
  updatedAt: 0,
}

/** 把任意存储内容规整成完整状态。 */
function normalize(parsed) {
  const source = parsed && typeof parsed === 'object' ? parsed : {}
  const text = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback
  const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback
  const number = (value, fallback, min, max) => {
    const parsedNumber = Number(value)
    return Number.isFinite(parsedNumber) ? Math.max(min, Math.min(max, Math.round(parsedNumber))) : fallback
  }
  const list = (value) => Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : []
  const map = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const result = {}
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && item.trim()) result[key] = item.trim()
    }
    return result
  }
  const domain = text(source.domain, DEFAULTS.domain).toLowerCase() === 'lark' ? 'lark' : 'feishu'
  const sessionMode = text(source.sessionMode, DEFAULTS.sessionMode)
  const notify = source.notify && typeof source.notify === 'object' ? source.notify : {}
  const permission = text(source.defaultPermission, DEFAULTS.defaultPermission)
  return {
    version: VERSION,
    webhookUrl: text(source.webhookUrl, DEFAULTS.webhookUrl),
    enableWebhook: bool(source.enableWebhook, DEFAULTS.enableWebhook),
    webhookAtAll: bool(source.webhookAtAll, DEFAULTS.webhookAtAll),
    notifyTurnEnd: bool(source.notifyTurnEnd, DEFAULTS.notifyTurnEnd),
    cardTitle: text(source.cardTitle, DEFAULTS.cardTitle),
    maxChars: number(source.maxChars, DEFAULTS.maxChars, 200, 8000),
    appId: text(source.appId, DEFAULTS.appId),
    appSecret: text(source.appSecret, DEFAULTS.appSecret),
    domain,
    enableInbound: bool(source.enableInbound, DEFAULTS.enableInbound),
    allowedOpenIds: list(source.allowedOpenIds),
    ownerOpenId: text(source.ownerOpenId, DEFAULTS.ownerOpenId),
    homeChatId: text(source.homeChatId, DEFAULTS.homeChatId),
    botName: text(source.botName, DEFAULTS.botName),
    botOpenId: text(source.botOpenId, DEFAULTS.botOpenId),
    onboardedAt: Number.isFinite(source.onboardedAt) ? source.onboardedAt : 0,
    sessionMode: ['fixed', 'perChat', 'active'].includes(sessionMode) ? sessionMode : 'perChat',
    sessionCwd: text(source.sessionCwd, DEFAULTS.sessionCwd),
    workspaceTitle: text(source.workspaceTitle, DEFAULTS.workspaceTitle),
    allowCommands: bool(source.allowCommands, DEFAULTS.allowCommands),
    inboundReply: bool(source.inboundReply, DEFAULTS.inboundReply),
    followNoticeSwitch: bool(source.followNoticeSwitch, DEFAULTS.followNoticeSwitch),
    lastNoticeSessionId: text(source.lastNoticeSessionId, DEFAULTS.lastNoticeSessionId),
    lastNoticeAt: Number.isFinite(source.lastNoticeAt) ? source.lastNoticeAt : 0,
    awayMode: bool(source.awayMode, DEFAULTS.awayMode),
    chatSessions: map(source.chatSessions),
    notify: {
      turnEnd: bool(notify.turnEnd, true),
      approval: bool(notify.approval, true),
      question: bool(notify.question, true),
    },
    defaultPermission: ['readonly', 'workspace', 'auto', 'full'].includes(permission) ? permission : 'workspace',
    chatPermissions: map(source.chatPermissions),
    answerMode: text(source.answerMode, DEFAULTS.answerMode) === 'both' ? 'both' : 'feishu',
    answerTimeoutMinutes: number(source.answerTimeoutMinutes, DEFAULTS.answerTimeoutMinutes, 0, 120),
    trace: bool(source.trace, DEFAULTS.trace),
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : 0,
  }
}

/** 读取状态；文件不存在或损坏时按默认值处理。 */
export async function readState() {
  try {
    return normalize(JSON.parse(await readFile(stateFile(), 'utf8')))
  } catch {
    return normalize(undefined)
  }
}

/** 原子写入状态，权限 0600。 */
export async function writeState(next) {
  const state = normalize(next)
  await mkdir(stateDir(), { recursive: true, mode: 0o700 })
  const target = stateFile()
  const temporary = `${target}.tmp`
  const value = { ...state, updatedAt: Date.now() }
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await chmod(temporary, 0o600).catch(() => {})
  await rename(temporary, target)
  await chmod(target, 0o600).catch(() => {})
  return normalize(value)
}

/** 清空状态（断开）。 */
export async function clearState() {
  await rm(stateFile(), { force: true })
  return normalize(undefined)
}

/** 给浏览器看的投影：webhook 与 App Secret 只回掩码/布尔。 */
export function publicState(state) {
  const value = normalize(state)
  const mask = (secret) => {
    if (!secret) return ''
    const tail = secret.slice(-4)
    return `********${tail}`
  }
  return {
    configured: Boolean(value.webhookUrl),
    appConfigured: Boolean(value.appId && value.appSecret),
    notify: value.notify,
    webhookMasked: mask(value.webhookUrl),
    enableWebhook: value.enableWebhook,
    webhookAtAll: value.webhookAtAll,
    notifyTurnEnd: value.notifyTurnEnd,
    cardTitle: value.cardTitle,
    maxChars: value.maxChars,
    appId: value.appId,
    appSecretMasked: mask(value.appSecret),
    appSecretConfigured: Boolean(value.appSecret),
    domain: value.domain,
    enableInbound: value.enableInbound,
    allowedOpenIds: value.allowedOpenIds,
    ownerOpenId: value.ownerOpenId,
    homeChatId: value.homeChatId,
    botName: value.botName,
    botOpenId: value.botOpenId,
    onboardedAt: value.onboardedAt,
    sessionMode: value.sessionMode,
    sessionCwd: value.sessionCwd,
    workspaceTitle: value.workspaceTitle,
    allowCommands: value.allowCommands,
    inboundReply: value.inboundReply,
    followNoticeSwitch: value.followNoticeSwitch,
    awayMode: value.awayMode,
    chatSessions: value.chatSessions,
    notify: value.notify,
    defaultPermission: value.defaultPermission,
    chatPermissions: value.chatPermissions,
    answerMode: value.answerMode,
    answerTimeoutMinutes: value.answerTimeoutMinutes,
    trace: value.trace,
    updatedAt: value.updatedAt,
  }
}
