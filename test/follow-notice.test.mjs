import test from 'node:test'
import assert from 'node:assert/strict'

import { createInbound } from '../lib/inbound-full.js'

function makeState(overrides = {}) {
  return {
    version: 3,
    webhookUrl: 'https://example.invalid/hook',
    enableWebhook: false,
    webhookAtAll: true,
    notifyTurnEnd: true,
    cardTitle: 'DSH 任务结束提醒',
    maxChars: 1200,
    appId: 'cli_test',
    appSecret: 'secret_test',
    domain: 'feishu',
    enableInbound: true,
    allowedOpenIds: ['ou_user_1'],
    ownerOpenId: 'ou_user_1',
    homeChatId: '',
    botName: '测试机器人',
    botOpenId: '',
    sessionMode: 'active',
    sessionCwd: '~/dsh-feishu-mcp',
    workspaceTitle: '飞书 DSH',
    allowCommands: true,
    inboundReply: true,
    followNoticeSwitch: true,
    lastNoticeSessionId: 'session-notice',
    lastNoticeAt: Date.now(),
    chatSessions: {},
    notify: { turnEnd: true, approval: true, question: true },
    trace: false,
    updatedAt: 0,
    ...overrides,
  }
}

function event() {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user_1' } },
    message: {
      message_id: 'om_follow_1',
      chat_id: 'oc_follow_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '继续刚才那个任务' }),
    },
  }
}

test('飞书私聊静默跟随最近通知所属会话，而不是另开新会话', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-token' }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
  }

  let state = makeState()
  const promptCalls = []
  const traces = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          create: async () => { throw new Error('不应该新建会话') },
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
    replyText: async () => {},
    log() {},
    trace: (name, data) => { traces.push({ name, data }) },
    sessions: {
      current: async () => undefined,
      ensureWorkspace: async () => undefined,
    },
  })

  try {
    await inbound.handle(event())
    assert.equal(promptCalls.length, 1)
    assert.equal(promptCalls[0].sessionId, 'session-notice')
    assert.equal(state.chatSessions.oc_follow_1, 'session-notice')
    assert.equal(state.lastNoticeSessionId, '')
    assert.ok(traces.some((entry) => entry.name === 'silent-follow-notice'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('关闭跟随时不采用最近通知会话', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-token' }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
  }

  let state = makeState({ followNoticeSwitch: false })
  const promptCalls = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          create: async () => ({ sessionId: 'session_fresh' }),
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
    replyText: async () => {},
    log() {},
    trace() {},
    sessions: {
      current: async () => undefined,
      ensureWorkspace: async () => undefined,
    },
  })

  try {
    await inbound.handle(event())
    assert.equal(promptCalls.length, 1)
    assert.equal(promptCalls[0].sessionId, 'session_fresh')
  } finally {
    globalThis.fetch = originalFetch
  }
})
