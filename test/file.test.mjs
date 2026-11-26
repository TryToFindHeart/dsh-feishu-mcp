import test from 'node:test'
import assert from 'node:assert/strict'

import { createInbound } from '../lib/inbound-full.js'

function makeState() {
  return {
    version: 3,
    webhookUrl: '',
    webhookAtAll: true,
    notifyTurnEnd: true,
    cardTitle: 'DSH 任务结束提醒',
    maxChars: 1200,
    appId: 'cli_file_test',
    appSecret: 'secret_file_test',
    domain: 'feishu',
    enableInbound: true,
    allowedOpenIds: ['ou_user_1'],
    ownerOpenId: 'ou_user_1',
    homeChatId: 'oc_chat_1',
    chatSessions: { oc_chat_1: 'session_file_1' },
    allowCommands: true,
    inboundReply: true,
    sessionMode: 'perChat',
    sessionCwd: '~/dsh-feishu-mcp',
    workspaceTitle: '飞书 DSH',
    trace: false,
    updatedAt: 0,
  }
}

function fileEvent() {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user_1' } },
    message: {
      message_id: 'om_file_1',
      chat_id: 'oc_chat_1',
      chat_type: 'p2p',
      message_type: 'file',
      content: JSON.stringify({ file_key: 'file_key_1', file_name: 'report.txt' }),
    },
  }
}

function installFetch() {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'token-file', expire: 7200 }), { status: 200 })
    }
    if (url.includes('/resources/file_key_1')) {
      return new Response(Buffer.from('hello file'), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    }
    if (url.includes('/reactions')) {
      return new Response(JSON.stringify({ code: 0, data: { reaction_id: 'reaction-1' } }), { status: 200 })
    }
    if (url.includes('/im/v1/messages')) {
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_reply_1' } }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0 }), { status: 200 })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('飞书文件消息下载后按会话回执进入 DSH', async () => {
  const state = makeState()
  const promptCalls = []
  const uploads = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return { prompt: async (request) => { promptCalls.push(request) } }
      }
      if (name === 'fileUploads') {
        return {
          uploadStream: async (request) => {
            uploads.push(request)
            return { receiptId: 'receipt-file-1', file: { bytes: 10 } }
          },
        }
      }
      return undefined
    },
  }
  const inbound = createInbound({
    ctx,
    readState: async () => state,
    writeState: async (next) => ({ ...state, ...next }),
    log: () => {},
    trace: () => {},
  })
  const fake = installFetch()

  try {
    await inbound.handle(fileEvent())

    assert.equal(promptCalls.length, 1)
    assert.equal(promptCalls[0].sessionId, 'session_file_1')
    assert.equal(promptCalls[0].mode, 'queue')
    assert.match(promptCalls[0].content[0].text, /report\.txt/)
    assert.deepEqual(promptCalls[0].content[1], { type: 'file', receiptId: 'receipt-file-1' })

    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].sessionId, 'session_file_1')
    assert.equal(uploads[0].name, 'report.txt')
    const chunks = []
    for await (const chunk of uploads[0].data) chunks.push(Buffer.from(chunk))
    assert.equal(Buffer.concat(chunks).toString(), 'hello file')
    assert.ok(fake.calls.some((call) => call.url.includes('?type=file')))
  } finally {
    fake.restore()
  }
})

test('缺少 fileUploads 服务时文件消息会给出提示而不是静默丢失', async () => {
  const state = makeState()
  const promptCalls = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') return { prompt: async (request) => { promptCalls.push(request) } }
      return undefined
    },
  }
  const inbound = createInbound({
    ctx,
    readState: async () => state,
    writeState: async (next) => ({ ...state, ...next }),
    log: () => {},
    trace: () => {},
  })
  const fake = installFetch()

  try {
    await inbound.handle(fileEvent())
    assert.equal(promptCalls.length, 0)
    assert.ok(fake.calls.some((call) => call.url.includes('/im/v1/messages')))
  } finally {
    fake.restore()
  }
})
