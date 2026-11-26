import test from 'node:test'
import assert from 'node:assert/strict'

import { createInbound } from '../lib/inbound-full.js'

function makeState(overrides = {}) {
  return {
    version: 3,
    webhookUrl: '',
    webhookAtAll: false,
    notifyTurnEnd: true,
    cardTitle: 'DSH 任务结束提醒',
    maxChars: 1200,
    appId: 'cli_test',
    appSecret: 'secret_test',
    domain: 'feishu',
    enableInbound: true,
    allowedOpenIds: ['ou_user_1'],
    ownerOpenId: 'ou_user_1',
    homeChatId: 'oc_chat_1',
    sessionMode: 'perChat',
    sessionCwd: '~/dsh-feishu-mcp',
    workspaceTitle: '飞书 DSH',
    allowCommands: true,
    inboundReply: true,
    chatSessions: { oc_chat_1: 'session_bound_1' },
    followNoticeSwitch: false,
    sessionSwitchLimit: 0,
    trace: false,
    updatedAt: 0,
    ...overrides,
  }
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(data),
  }
}

function imageResponse(bytes, contentType) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}

function installFetch(imageBytes) {
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url)
    calls.push(value)
    if (value.includes('/auth/v3/tenant_access_token/internal')) {
      return jsonResponse({ code: 0, tenant_access_token: 't_test' })
    }
    if (value.includes('/resources/img_test_1')) {
      return imageResponse(imageBytes, 'image/png')
    }
    if (value.includes('/reactions')) {
      return jsonResponse({ code: 0, data: { reaction_id: 'reaction_test' } })
    }
    return jsonResponse({ code: 0 })
  }
  return calls
}

function makeInbound(state, promptCalls) {
  const sessions = {
    current: async () => 'session_bound_1',
    resolve: async () => undefined,
    chatOfSession: async () => 'oc_chat_1',
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
      if (name === 'agents') return { get: () => ({ status: 'idle' }) }
      return undefined
    },
  }
  return createInbound({
    ctx,
    readState: async () => state,
    writeState: async (next) => ({ ...state, ...next }),
    replyText: async () => {},
    log: () => {},
    trace: () => {},
    sessions,
    postCard: async () => ({ messageId: 'om_card_test' }),
    updateCardMessage: async () => {},
  })
}

test('飞书图片消息下载真实字节后作为 DSH 图片内容块送达', async () => {
  const originalFetch = globalThis.fetch
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  installFetch(bytes)
  try {
    let state = makeState()
    const promptCalls = []
    const inbound = makeInbound(state, promptCalls)

    await inbound.handle({
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_user_1' } },
      message: {
        message_id: 'om_image_1',
        chat_id: 'oc_chat_1',
        chat_type: 'p2p',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_test_1' }),
      },
    })

    assert.equal(promptCalls.length, 1)
    assert.equal(promptCalls[0].content[0].type, 'text')
    assert.equal(promptCalls[0].content[0].text, '请识别这张图片并描述内容。')
    const image = promptCalls[0].content[1]
    assert.equal(image.type, 'image')
    assert.equal(image.mediaType, 'image/png')
    assert.equal(image.data, bytes.toString('base64'))
    assert.match(image.name, /^feishu-om_image_1-img_test_1\.png$/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('飞书 post 消息中的正文和图片一起进入 DSH', async () => {
  const originalFetch = globalThis.fetch
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  installFetch(bytes)
  try {
    const state = makeState()
    const promptCalls = []
    const inbound = makeInbound(state, promptCalls)

    await inbound.handle({
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_user_1' } },
      message: {
        message_id: 'om_post_1',
        chat_id: 'oc_chat_1',
        chat_type: 'p2p',
        message_type: 'post',
        content: JSON.stringify({
          title: '看看这个',
          content: [[
            { tag: 'text', text: '这是什么' },
            { tag: 'image', image_key: 'img_test_1' },
          ]],
        }),
      },
    })

    assert.equal(promptCalls.length, 1)
    assert.equal(promptCalls[0].content[0].text, '看看这个 这是什么')
    assert.equal(promptCalls[0].content[1].type, 'image')
    assert.equal(promptCalls[0].content[1].mediaType, 'image/png')
  } finally {
    globalThis.fetch = originalFetch
  }
})
