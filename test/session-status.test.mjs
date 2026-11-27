import test from 'node:test'
import assert from 'node:assert/strict'

import { sessionStatusCard, sessionStatusText } from '../lib/session-status.js'
import { createInbound } from '../lib/inbound-full.js'

function makeLive() {
  return {
    requestHeader: () => ({ config: { provider: 'magpie', model: 'auto/hy4flash-free' } }),
  }
}

function makeCtx(live, values) {
  return {
    get(name) {
      if (name === 'sessions') return { get: () => live }
      if (name === 'sessionProjections') return { snapshot: () => ({ values }) }
      if (name === 'tokenMeter') return { contextPressure: () => ({ pressureTokens: 42000, contextWindow: 64000 }) }
      return undefined
    },
  }
}

test('/id 状态信息读取整段会话统计与 token 用量', async () => {
  const ctx = makeCtx(makeLive(), {
    sessionStats: { turns: 7, steps: 19 },
    tokenUsage: {
      uncachedInputTokens: 1200,
      outputTokens: 800,
      cacheReadTokens: 10800,
      cacheWriteTokens: 200,
    },
    contextPressure: { pressureTokens: 41000, projectedTokens: 43000, contextWindow: 64000 },
    modelSelection: { lastUsed: { provider: 'magpie', model: 'auto/hy4flash-free' } },
  })
  const text = await sessionStatusText({
    ctx,
    sessions: { resolve: async () => ({ label: '日志排查', cwd: '/workspace/demo' }) },
    models: {
      used: () => ({ provider: 'magpie', model: 'auto/hy4flash-free' }),
      current: () => ({ provider: 'magpie', model: 'auto/hy4flash-free' }),
      catalog: async () => undefined,
    },
    permissions: {
      effectiveMode: () => 'workspace',
      modeOf: () => 'workspace',
    },
    readState: async () => ({ defaultPermission: 'workspace', sessionCwd: '~/dsh-feishu-mcp', workspaceTitle: '飞书 DSH' }),
    chatId: 'oc_chat_1',
    sessionId: 'session_status_1',
    label: '日志排查',
  })

  assert.match(text, /会话名称：日志排查/)
  assert.match(text, /会话 ID：session_status_1/)
  assert.match(text, /工作目录：\/workspace\/demo/)
  assert.match(text, /轮次 \/ 步数：7 轮 \/ 19 步/)
  assert.match(text, /Token 累计：13,000/)
  assert.match(text, /缓存读取 10,800/)
  assert.match(text, /缓存命中：88\.5%/)
  assert.match(text, /上下文：42,000 \/ 64,000（剩余约 22,000）/)
  assert.match(text, /调用模型：magpie\/auto\/hy4flash-free/)
  assert.match(text, /当前权限：工作区读写/)
})

test('缺少统计数据时明确标注未读取到', async () => {
  const text = await sessionStatusText({
    ctx: { get: () => undefined },
    sessions: { resolve: async () => undefined },
    readState: async () => ({ defaultPermission: 'workspace' }),
    chatId: 'oc_chat_1',
    sessionId: 'session_status_2',
  })

  assert.match(text, /轮次 \/ 步数：未读取到 轮 \/ 未读取到 步/)
  assert.match(text, /Token 累计：未读取到/)
  assert.match(text, /缓存命中：未读取到/)
  assert.match(text, /上下文：未读取到 \/ 未读取到/)
  assert.match(text, /调用模型：默认模型（未读取到具体路由）/)
  assert.match(text, /当前权限：工作区读写/)
})

test('/id 长文本反馈用蓝色卡片展示，正文不丢失', () => {
  const body = '会话名称：日志排查\n会话 ID：session_1\n轮次 / 步数：7 轮 / 19 步\n调用模型：magpie/auto/hy4flash-free'
  const card = sessionStatusCard(body)

  assert.equal(card.header.template, 'blue')
  assert.equal(card.header.title.tag, 'plain_text')
  assert.equal(card.elements.length, 1)
  assert.equal(card.elements[0].tag, 'div')
  assert.equal(card.elements[0].text.tag, 'lark_md')
  assert.equal(card.elements[0].text.content, body)
  assert.match(card.elements[0].text.content, /调用模型：/)
})

test('full 版 /id 通过蓝色卡片返回状态，不再只发纯文本', async () => {
  const state = {
    appId: 'cli_status_test',
    appSecret: 'secret_status_test',
    chatSessions: { oc_chat_1: 'session_status_3' },
    allowedOpenIds: ['ou_user_1'],
    allowCommands: true,
    defaultPermission: 'workspace',
    workspaceTitle: '飞书 DSH',
    sessionCwd: '~/dsh-feishu-mcp',
  }
  const cards = []
  const inbound = createInbound({
    ctx: { get: () => undefined },
    readState: async () => state,
    writeState: async () => state,
    log: () => {},
    trace: () => {},
    sessions: { resolve: async () => ({ label: '状态测试' }) },
    postCard: async (chatId, card) => { cards.push({ chatId, card }) },
  })

  await inbound.handle({
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user_1' } },
    message: {
      message_id: 'om_status_1',
      chat_id: 'oc_chat_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '/id' }),
    },
  })

  assert.equal(cards.length, 1)
  assert.equal(cards[0].chatId, 'oc_chat_1')
  assert.equal(cards[0].card.header.template, 'blue')
  assert.match(cards[0].card.elements[0].text.content, /会话 ID：session_status_3/)
  assert.match(cards[0].card.elements[0].text.content, /继续发消息即可/)
})
