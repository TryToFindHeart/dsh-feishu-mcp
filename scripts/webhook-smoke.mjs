/**
 * 出站 webhook 连通性冒烟测试。
 *
 * 用法：
 *   FEISHU_WEBHOOK=https://... node scripts/webhook-smoke.mjs
 *   node scripts/webhook-smoke.mjs --url https://... [--no-at-all] [--save]
 *
 * --save 会把 --url 写入本地 state.json（0600），方便后续走插件通知。
 */
import { buildContentCards } from '../lib/card.js'
import { readState, writeState } from '../lib/state.js'
import { sendWebhookCard } from '../lib/webhook.js'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const valueOf = (name) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : ''
}

const url = valueOf('--url') || process.env.FEISHU_WEBHOOK || ''
const noAtAll = flag('--no-at-all')
const save = flag('--save')

if (!url) {
  console.error('请通过 FEISHU_WEBHOOK 环境变量或 --url 传入飞书 webhook 地址')
  process.exit(1)
}

const current = await readState()
const state = { ...current, webhookUrl: url, webhookAtAll: !noAtAll }

if (save) {
  const saved = await writeState(state)
  console.log('已保存配置（掩码）：', saved.webhookUrl.slice(0, 12) + '****' + saved.webhookUrl.slice(-8))
}

const cards = buildContentCards({
  title: 'DSH 飞书通知 · 连通性测试',
  template: 'blue',
  subtitle: 'webhook smoke test',
  markdown: [
    '**这是一条来自 DSH 飞书通知插件的测试消息。**',
    '',
    '- 看到这张卡片说明出站 webhook 已连通。',
    '- 之后每轮任务结束都会收到一张结果卡片。',
    '',
    `> 测试时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
  ].join('\n'),
  note: 'dsh-feishu-mcp · outbound only',
  mentionAll: !noAtAll,
})

let ok = true
for (let index = 0; index < cards.length; index += 1) {
  try {
    const result = await sendWebhookCard(state, cards[index])
    console.log(`卡片 ${index + 1}/${cards.length} 发送成功：`, JSON.stringify(result))
  } catch (error) {
    ok = false
    console.error(`卡片 ${index + 1}/${cards.length} 发送失败：`, error.message)
  }
}

process.exit(ok ? 0 : 1)
