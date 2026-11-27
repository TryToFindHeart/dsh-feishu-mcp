import test from 'node:test'
import assert from 'node:assert/strict'

import { createInbound, deliveryMode, textOf } from '../lib/inbound.js'

function makeState(overrides = {}) {
  return {
    version: 2,
    webhookUrl: '',
    webhookAtAll: true,
    notifyTurnEnd: true,
    cardTitle: 'DSH 任务结束提醒',
    maxChars: 1200,
    appId: 'cli_test',
    appSecret: 'secret_test',
    domain: 'feishu',
    enableInbound: true,
    allowedOpenIds: [],
    ownerOpenId: '',
    homeChatId: '',
    sessionMode: 'perChat',
    sessionCwd: '~/dsh-feishu-mcp',
    workspaceTitle: '飞书 DSH',
    allowCommands: true,
    inboundReply: true,
    chatSessions: {},
    trace: false,
    updatedAt: 0,
    ...overrides,
  }
}

function messageEvent(overrides = {}) {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user_1' } },
    message: {
      message_id: 'om_message_1',
      chat_id: 'oc_chat_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '帮我查一下日志' }),
      ...overrides,
    },
  }
}

test('textOf 解析正文并剔除 @提及', () => {
  const text = textOf({
    message_type: 'text',
    content: JSON.stringify({ text: '@_user_1 你好' }),
    mentions: [{ key: '@_user_1' }],
  })
  assert.equal(text, '你好')
  assert.equal(textOf({ message_type: 'image', content: '{}' }), null)
})

test('deliveryMode：忙时默认插话，排队需显式指定', () => {
  assert.equal(deliveryMode(true), 'steer')
  assert.equal(deliveryMode(true, true), 'queue')
  assert.equal(deliveryMode(false), 'queue')
})

test('私聊消息进入 DSH 会话，并由 message_id 去重', async () => {
  let state = makeState()
  const promptCalls = []
  const replyCalls = []
  const sessions = {
    current: async () => undefined,
    ensureWorkspace: async () => undefined,
  }
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          create: async () => ({ sessionId: 'session_created_1' }),
          prompt: async (request) => { promptCalls.push(request) },
        }
      }
      return undefined
    },
  }
  const inbound = createInbound({
    ctx,
    readState: async () => state,
    writeState: async (next) => { state = { ...state, ...next }; return state },
    replyText: async (chatId, text) => { replyCalls.push({ chatId, text }) },
    log: () => {},
    trace: () => {},
    sessions,
  })

  await inbound.handle(messageEvent())

  assert.equal(promptCalls.length, 1)
  assert.equal(promptCalls[0].requestId, 'feishu:om_message_1')
  assert.equal(promptCalls[0].sessionId, 'session_created_1')
  assert.equal(promptCalls[0].mode, 'queue')
  assert.equal(promptCalls[0].content[0].text, '帮我查一下日志')
  const reply = inbound.takeReply('session_created_1')
  assert.equal(reply.chatId, 'oc_chat_1')
  assert.equal(reply.messageId, 'om_message_1')
  assert.ok(reply.at > 0)

  // 同一条 Feishu 事件重发不应再次进入 DSH。
  await inbound.handle(messageEvent())
  assert.equal(promptCalls.length, 1)
  assert.match(replyCalls[0].text, /唯一使用者/)
})

test('群聊消息被忽略', async () => {
  let state = makeState({ allowedOpenIds: ['ou_user_1'] })
  const promptCalls = []
  const ctx = {
    get: () => ({
      create: async () => ({ sessionId: 'ignored' }),
      prompt: async (request) => { promptCalls.push(request) },
    }),
  }
  const inbound = createInbound({
    ctx,
    readState: async () => state,
    writeState: async (next) => { state = { ...state, ...next }; return state },
    replyText: async () => {},
    log: () => {},
    trace: () => {},
    sessions: { current: async () => undefined, ensureWorkspace: async () => undefined },
  })

  await inbound.handle(messageEvent({
    message_id: 'om_group_1',
    chat_id: 'oc_group_1',
    chat_type: 'group',
  }))

  assert.equal(promptCalls.length, 0)
})

test('/id 同时返回会话名称与 ID', async () => {
  const state = makeState({
    allowedOpenIds: ['ou_user_1'],
    chatSessions: { oc_chat_1: 'session_named_1' },
  })
  const replyCalls = []
  const sessions = {
    current: async () => 'session_named_1',
    resolve: async (chatId, ref) => ({
      sessionId: ref,
      label: '日志排查',
      title: '日志排查',
      cwd: '/workspace/demo',
    }),
    ensureWorkspace: async () => undefined,
  }
  const inbound = createInbound({
    ctx: { get: () => undefined },
    readState: async () => state,
    writeState: async (next) => { state = { ...state, ...next }; return state },
    replyText: async (chatId, text) => { replyCalls.push({ chatId, text }) },
    log: () => {},
    trace: () => {},
    sessions,
  })

  await inbound.handle(messageEvent({
    message_id: 'om_id_1',
    content: JSON.stringify({ text: '/id' }),
  }))

  assert.equal(replyCalls.length, 1)
  assert.match(replyCalls[0].text, /会话名称：日志排查/)
  assert.match(replyCalls[0].text, /会话 ID：session_named_1/)
})
