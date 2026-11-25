/**
 * 插件的持久化状态。
 *
 * webhook URL 本身就是密钥（谁拿到都能往群里发消息），所以不写进
 * cordis.patch.yml，也不放进普通 Config。这里用 `$DSH_HOME/dsh-feishu-mcp/
 * state.json`，权限 0600，原子替换写入；这是最小且安全的持久化方式。
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VERSION = 1

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
  webhookUrl: '',
  webhookAtAll: true,
  notifyTurnEnd: true,
  cardTitle: 'DSH 任务结束提醒',
  maxChars: 1200,
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
  return {
    version: VERSION,
    webhookUrl: text(source.webhookUrl, ''),
    webhookAtAll: bool(source.webhookAtAll, DEFAULTS.webhookAtAll),
    notifyTurnEnd: bool(source.notifyTurnEnd, DEFAULTS.notifyTurnEnd),
    cardTitle: text(source.cardTitle, DEFAULTS.cardTitle),
    maxChars: number(source.maxChars, DEFAULTS.maxChars, 200, 8000),
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

/** 给浏览器看的投影：webhook 只回掩码，绝不回原文。 */
export function publicState(state) {
  const value = normalize(state)
  let webhookMasked = ''
  if (value.webhookUrl) {
    const suffix = value.webhookUrl.slice(-8)
    webhookMasked = `********${suffix}`
  }
  return {
    configured: Boolean(value.webhookUrl),
    webhookMasked,
    webhookAtAll: value.webhookAtAll,
    notifyTurnEnd: value.notifyTurnEnd,
    cardTitle: value.cardTitle,
    maxChars: value.maxChars,
    trace: value.trace,
    updatedAt: value.updatedAt,
  }
}
