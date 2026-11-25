import test from 'node:test'
import assert from 'node:assert/strict'

import { buildContentCards } from '../lib/card.js'
import { createNotifier, turnNotice } from '../lib/notifier.js'
import { sendWebhook } from '../lib/webhook.js'

const baseState = {
  webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
  webhookAtAll: true,
  notifyTurnEnd: true,
  cardTitle: 'DSH 任务结束提醒',
  maxChars: 1200,
  trace: false,
}

function installFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('buildContentCards 返回 Card 2.0 并支持 @all', () => {
  const cards = buildContentCards({
    title: '测试',
    markdown: '**正文**',
    mentionAll: true,
  })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].schema, '2.0')
  assert.equal(cards[0].header.title.content, '测试')
  assert.match(cards[0].body.elements[0].content, /<at id=all>/)
})

test('默认用 markdown 表格，不生成原生 table 元素', () => {
  const cards = buildContentCards({
    title: '表格',
    markdown: '| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |',
  })
  const content = cards[0].body.elements.map((element) => element.content).join('\n')
  assert.match(content, /\| 列 A \| 列 B \|/)
  assert.ok(!cards[0].body.elements.some((element) => element.tag === 'table'))
})

test('长正文分页但最多 6 张卡片', () => {
  const long = Array.from({ length: 1200 }, (_, index) => `第 ${index + 1} 行内容`).join('\n')
  const cards = buildContentCards({ title: '长文', markdown: long })
  assert.ok(cards.length > 1)
  assert.ok(cards.length <= 6)
})

test('turnNotice 只保留必要字段并截断正文', () => {
  const notice = turnNotice({
    session: { id: 'session-abc123', header: { cwd: '/workspace/demo' } },
    reason: { kind: 'completed' },
    text: 'x'.repeat(100),
    durationMs: 65000,
    maxChars: 20,
  })
  assert.match(notice.title, /任务完成/)
  assert.equal(notice.template, 'green')
  assert.match(notice.markdown, /已截断/)
})

test('sendWebhook 把非 0 code 当作失败', async () => {
  const fake = installFetch(async () => new Response(JSON.stringify({ code: 1, msg: 'bad token' }), { status: 200 }))
  try {
    await assert.rejects(
      () => sendWebhook(baseState.webhookUrl, { msg_type: 'text' }),
      /bad token/,
    )
    assert.equal(fake.calls.length, 1)
  } finally {
    fake.restore()
  }
})

test('notifier 在 turn/end 只发一张含 @all 的卡片，取消轮次静默', async () => {
  const fake = installFetch(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }))
  const calls = []
  const notifier = createNotifier({
    readState: async () => ({ ...baseState, maxChars: 1200 }),
    log: () => {},
    trace: (kind) => calls.push(kind),
  })
  const session = { id: 'session-1', header: { cwd: '/workspace/demo' } }

  try {
    await notifier.onSessionEvent(session, { type: 'turn/start' })
    await notifier.onSessionEvent(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '任务完成' }] } } })
    await notifier.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(calls, ['card-sent'])
    assert.equal(fake.calls.length, 1)
    const sent = JSON.parse(fake.calls[0].init.body)
    assert.equal(sent.msg_type, 'interactive')
    assert.match(sent.card.body.elements[0].content, /<at id=all>/)

    calls.length = 0
    fake.calls.length = 0
    await notifier.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'cancelled' } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(calls, [])
    assert.equal(fake.calls.length, 0)
  } finally {
    fake.restore()
  }
})

test('由飞书私聊发起的轮次只回原对话，不重复发 webhook', async () => {
  const fake = installFetch(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }))
  const chatCards = []
  const calls = []
  const notifier = createNotifier({
    readState: async () => ({ ...baseState, maxChars: 1200, inboundReply: true }),
    log: () => {},
    trace: (kind) => calls.push(kind),
    takeReply: (sessionId) => sessionId === 'session-chat' ? { chatId: 'oc_chat_1', messageId: 'om_1' } : undefined,
    sendChatCard: async (chatId, card) => { chatCards.push({ chatId, card }) },
  })
  const session = { id: 'session-chat', header: { cwd: '/workspace/demo' } }

  try {
    await notifier.onSessionEvent(session, { type: 'turn/start' })
    await notifier.onSessionEvent(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '任务完成' }] } } })
    await notifier.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.equal(fake.calls.length, 0)
    assert.equal(chatCards.length, 1)
    assert.equal(chatCards[0].chatId, 'oc_chat_1')
    const chatContent = chatCards[0].card.body.elements.map((element) => element.content || '').join('\n')
    assert.match(chatContent, /任务完成/)
    assert.ok(calls.includes('chat-card-sent'))
  } finally {
    fake.restore()
  }
})
