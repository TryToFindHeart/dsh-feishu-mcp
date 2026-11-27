/**
 * 会话状态卡的数据来源统一收口。
 *
 * `/id` 及其别名只做本地读取：会话统计、token 用量、上下文压力、模型路由、
 * 权限模式都从 DSH 已安装的投影和服务读取。拿不到的数据明确标注，不猜测。
 * 这些数字是整段会话日志的累计值，不是最近一轮的数据。
 */

import { modelLabel } from './models.js'
import { PERMISSION_MODES } from './permissions.js'

function get(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('zh-CN') : null
}

function percent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : null
}

function readTokenUsage(values) {
  const usage = values?.tokenUsage
  if (!usage || typeof usage !== 'object') return null
  const input = usage.uncachedInputTokens ?? usage.inputTokens
  const output = usage.outputTokens
  const read = usage.cacheReadTokens
  const write = usage.cacheWriteTokens
  const parts = [input, output, read, write].filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (parts.length === 0) return null
  const prompt = [input, read, write].filter((value) => typeof value === 'number' && Number.isFinite(value))
    .reduce((total, value) => total + value, 0)
  return {
    total: parts.reduce((total, value) => total + value, 0),
    input,
    output,
    read,
    write,
    hit: prompt > 0 && typeof read === 'number' ? read / prompt : null,
  }
}

function readContext(values, live, ctx) {
  let pressure = null
  try {
    pressure = get(ctx, 'tokenMeter')?.contextPressure?.(live) || null
  } catch {
    // 宿主没有暴露该服务时只读取投影。
  }
  const projected = values?.contextPressure || {}
  const used = pressure?.pressureTokens ?? projected.pressureTokens ?? projected.projectedTokens
  const capacity = pressure?.contextWindow ?? projected.contextWindow
  const projectedTokens = projected.projectedTokens ?? used
  const remaining = typeof used === 'number' && typeof capacity === 'number' ? capacity - used : null
  return { used, projectedTokens, capacity, remaining }
}

/**
 * 生成 `/id` 的会话状态文本。
 *
 * @param {object} options
 * @param {object} options.ctx Cordis 上下文，用于读取会话、投影和服务。
 * @param {object} options.sessions 插件的会话定位服务。
 * @param {object} [options.models] 插件的模型读取服务。
 * @param {object} [options.permissions] 插件的权限服务。
 * @param {Function} options.readState 读取插件配置。
 * @param {string} options.chatId 飞书对话 ID。
 * @param {string} options.sessionId 已绑定的 DSH 会话 ID。
 * @param {string} [options.label] 已解析出的会话名称。
 * @param {object} [options.state] 已读取过的插件配置，避免重复读取。
 * @returns {Promise<string>} 可直接发给飞书的纯文本。
 */
export async function sessionStatusText({ ctx, sessions, models, permissions, readState, chatId, sessionId, label = '', state }) {
  const lines = []
  const sessionState = state || (typeof readState === 'function' ? await readState() : {}) || {}

  let resolved = null
  try {
    resolved = await sessions?.resolve?.(chatId, sessionId)
  } catch {
    // 名称解析失败不影响其它指标。
  }
  const title = String(label || resolved?.label || resolved?.title || sessionState?.sessionTitle || '')
  lines.push(`会话名称：${title || '未读取到'}`)
  lines.push(`会话 ID：${sessionId}`)
  if (sessionState.sessionCwd || resolved?.cwd) lines.push(`工作目录：${resolved?.cwd || sessionState.sessionCwd}`)
  if (sessionState.workspaceTitle) lines.push(`工作区：${sessionState.workspaceTitle}`)

  const live = get(ctx, 'sessions')?.get?.(sessionId)
  let values = {}
  if (live) {
    try {
      values = get(ctx, 'sessionProjections')?.snapshot?.(live)?.values || {}
    } catch {
      values = {}
    }
  }

  const stats = values.sessionStats || {}
  const turns = count(stats.turns)
  const steps = count(stats.steps)
  lines.push(`轮次 / 步数：${turns ?? '未读取到'} 轮 / ${steps ?? '未读取到'} 步`)

  const usage = readTokenUsage(values)
  if (usage) {
    const parts = [
      `未缓存输入 ${count(usage.input) ?? '—'}`,
      `缓存读取 ${count(usage.read) ?? '—'}`,
      `缓存写入 ${count(usage.write) ?? '—'}`,
      `输出 ${count(usage.output) ?? '—'}`,
    ]
    lines.push(`Token 累计：${count(usage.total) ?? '—'}（${parts.join(' · ')}）`)
    lines.push(`缓存命中：${percent(usage.hit) ?? '未读取到'}`)
  } else {
    lines.push('Token 累计：未读取到')
    lines.push('缓存命中：未读取到')
  }

  const context = readContext(values, live, ctx)
  const capacity = count(context.capacity)
  const used = count(context.used)
  const remaining = count(context.remaining)
  lines.push(`上下文：${used ?? '未读取到'} / ${capacity ?? '未读取到'}${remaining ? `（剩余约 ${remaining}）` : ''}`)

  let modelText = ''
  try {
    const selection = (typeof models?.used === 'function' && models.used(sessionId, live)) || models?.current?.(sessionId, live)
    const catalog = await models?.catalog?.()
    modelText = modelLabel(selection, catalog)
    if (!selection && live?.requestHeader) {
      const header = live.requestHeader()
      modelText = modelLabel(header?.config, catalog)
    }
  } catch {
    modelText = ''
  }
  lines.push(`调用模型：${modelText || '默认模型（未读取到具体路由）'}`)

  let mode = sessionState.defaultPermission
  try {
    mode = permissions?.effectiveMode?.(sessionState, chatId, sessionId)
      || permissions?.modeOf?.(sessionState, chatId)
      || mode
  } catch {
    // 权限服务缺失时回退到插件配置里的默认值。
  }
  const spec = PERMISSION_MODES[mode]
  lines.push(`当前权限：${spec?.label || mode || '未读取到'}${spec?.hint ? `（${spec.hint}）` : ''}`)

  lines.push('以上统计来自当前会话的整段日志，不是本轮增量。')
  return lines.join('\n')
}

/**
 * 把会话状态文本包装成蓝色卡片（Card 1.0），用于私聊里展示这类长文本反馈。
 *
 * 正文用 `lark_md` 保留逐行结构；模型信息已经在正文的「调用模型」行里，
 * postCard 追加模型小字时会被 withModelFooter 去重，不会重复显示。
 *
 * @param {string} text sessionStatusText 生成的正文。
 * @param {string} [title] 卡片标题。
 * @returns {object} 可直接交给 postCard 的卡片对象。
 */
export function blueTextCard(text, title = '提示') {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: String(text || '') } },
    ],
  }
}

/** 兼容旧调用名：会话状态本质也是一张蓝色文本卡。 */
export const sessionStatusCard = (text, title = '会话状态') => blueTextCard(text, title)
