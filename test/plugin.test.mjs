import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { buildContentCards } from '../lib/card.js'
import { createNotifier, turnNotice } from '../lib/notifier.js'
import { createNotifier as createFullNotifier } from '../lib/notify-full.js'
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

test('/test 使用已保存的 webhook 地址发送测试卡片', async () => {
  const originalHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'dsh-feishu-mcp-test-'))
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(home, 'dsh-feishu-mcp'), { recursive: true })
  writeFileSync(
    join(home, 'dsh-feishu-mcp', 'state.json'),
    JSON.stringify({ version: 3, ...baseState, webhookAtAll: false }),
  )
  process.env.DSH_HOME = home

  const routes = []
  const ctx = {
    logger: { warn() {} },
    effect() {},
    on() {},
    get() { return undefined },
    inject(names, callback) {
      if (names.includes('connection')) {
        callback({
          connection: {
            fetch: {
              register(route) { routes.push(route) },
            },
          },
          effect(fn) { fn() },
        })
      } else {
        callback({ tools: { register() {} } })
      }
    },
  }

  apply(ctx)
  const route = routes.find((item) => item.path === '/api/feishu-mcp/test')
  assert.ok(route, '应注册 /api/feishu-mcp/test 路由')

  const fake = installFetch(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }))
  try {
    const response = await route.fetch(new Request('http://localhost/api/feishu-mcp/test', { method: 'POST' }))
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.ok, true)
    assert.equal(fake.calls.length, 1)
    assert.equal(fake.calls[0].url, baseState.webhookUrl)
  } finally {
    fake.restore()
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
  }
})

test('启用 Webhook 时普通轮次只发群卡片，不重复发应用机器人', async () => {
  const fake = installFetch(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }))
  const state = {
    ...baseState,
    enableWebhook: true,
    appId: 'cli_test',
    appSecret: 'secret',
    ownerOpenId: 'ou_test',
    notify: { turnEnd: true, approval: true, question: true },
  }
  const notifier = createFullNotifier({
    readState: async () => state,
    log() {},
    trace() {},
    takeReply() { return null },
    takeTyping() { return null },
  })
  const session = { id: 'session-webhook', header: { cwd: '/workspace/demo' } }
  try {
    await notifier.onSessionEvent(session, { type: 'turn/start' })
    await notifier.onSessionEvent(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '任务完成' }] } } })
    await notifier.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(fake.calls.length, 1)
    assert.equal(fake.calls[0].url, baseState.webhookUrl)
  } finally {
    fake.restore()
  }
})

test('关闭 Webhook 后普通轮次由应用机器人发回绑定会话并携带会话信息', async () => {
  const fake = installFetch(async (url) => {
    if (String(url).includes('tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-token' }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_sent' } }), { status: 200 })
  })
  const state = {
    ...baseState,
    webhookUrl: '',
    enableWebhook: false,
    appId: 'cli_test',
    appSecret: 'secret',
    homeChatId: 'oc_home',
    ownerOpenId: 'ou_test',
    notify: { turnEnd: true, approval: true, question: true },
  }
  const notifier = createFullNotifier({
    readState: async () => state,
    log() {},
    trace() {},
    takeReply() { return null },
    takeTyping() { return null },
    chatOfSession: async () => ({ chatId: 'oc_bound' }),
  })
  const session = { id: 'session-bound', header: { cwd: '/workspace/demo' } }
  try {
    await notifier.onSessionEvent(session, { type: 'turn/start' })
    await notifier.onSessionEvent(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '任务完成' }] } } })
    await notifier.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const send = fake.calls.find((call) => String(call.url).includes('/im/v1/messages'))
    assert.ok(send, '应通过应用机器人发送消息')
    assert.match(String(send.url), /receive_id_type=chat_id/)
    const body = JSON.parse(send.init.body)
    assert.equal(body.receive_id, 'oc_bound')
    const content = typeof body.content === 'string' ? JSON.parse(body.content) : body.content
    const text = JSON.stringify(content)
    assert.match(text, /会话/)
    assert.match(text, /任务完成/)
  } finally {
    fake.restore()
  }
})

test('关闭 Webhook 的普通轮次会记下通知所属会话，供下次静默跟随', async () => {
  const fake = installFetch(async (url) => {
    if (String(url).includes('tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-token' }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_sent' } }), { status: 200 })
  })
  const state = {
    ...baseState,
    webhookUrl: '',
    enableWebhook: false,
    followNoticeSwitch: true,
    appId: 'cli_test',
    appSecret: 'secret',
    ownerOpenId: 'ou_test',
    notify: { turnEnd: true, approval: true, question: true },
  }
  const writes = []
  const notifier = createFullNotifier({
    readState: async () => state,
    writeState: async (next) => { writes.push(next); return next },
    log() {},
    trace() {},
    takeReply() { return null },
    takeTyping() { return null },
    chatOfSession: async () => ({ chatId: 'oc_bound' }),
  })
  const session = { id: 'session-notice', header: { cwd: '/workspace/demo' } }
  try {
    await notifier.onSessionEvent(session, { type: 'turn/start' })
    await notifier.onSessionEvent(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '任务完成' }] } } })
    await notifier.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(writes.length, 1)
    assert.equal(writes[0].lastNoticeSessionId, 'session-notice')
    assert.ok(writes[0].lastNoticeAt > 0)
  } finally {
    fake.restore()
  }
})
