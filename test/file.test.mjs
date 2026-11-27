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

function fileEvent(messageId, fileKey, name) {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user_1' } },
    message: {
      message_id: messageId,
      chat_id: 'oc_chat_1',
      chat_type: 'p2p',
      message_type: 'file',
      content: JSON.stringify({ file_key: fileKey, file_name: name }),
    },
  }
}

function folderEvent(messageId, folderKey, name) {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user_1' } },
    message: {
      message_id: messageId,
      chat_id: 'oc_chat_1',
      chat_type: 'p2p',
      message_type: 'folder',
      content: JSON.stringify({ file_key: folderKey, file_name: name }),
    },
  }
}

function textEvent(text, messageId = 'om_text_1', extra = {}) {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user_1' } },
    message: {
      message_id: messageId,
      chat_id: 'oc_chat_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text }),
      ...extra,
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
    if (url.includes('/resources/')) {
      return new Response(Buffer.from('hello file'), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    }
    if (url.includes('/folder?')) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          items: [{ file_key: 'child_key_1', name: 'child.txt', is_folder: false }],
          all_count: '1',
        },
      }), { status: 200 })
    }
    const messageMatch = String(url).match(/\/messages\/([^/?]+)/)
    if (messageMatch && !String(url).includes('receive_id_type')) {
      const id = decodeURIComponent(messageMatch[1])
      const message = id === 'om_image_old'
        ? { message_type: 'image', content: JSON.stringify({ image_key: 'image_key_old' }) }
        : { message_type: 'file', content: JSON.stringify({ file_key: 'file_key_old', file_name: 'LAYOUT.md' }) }
      return new Response(JSON.stringify({ code: 0, data: { message } }), { status: 200 })
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

function replyTexts(calls) {
  return calls
    .filter((call) => call.url.includes('/im/v1/messages'))
    .map((call) => String(call.init?.body || ''))
}

function choiceId(card) {
  for (const element of card?.elements || []) {
    for (const action of element.actions || []) {
      if (action?.value?.k === 'filechoice') return String(action.value.id || '')
    }
  }
  return ''
}

function click(id, choice, openId = 'ou_user_1') {
  return {
    action: { value: { k: 'filechoice', id, v: choice, c: 'oc_chat_1' } },
    operator: { open_id: openId },
  }
}

function makeInbound(ctx, state, cards) {
  return createInbound({
    ctx,
    readState: async () => state,
    writeState: async (next) => ({ ...state, ...next }),
    log: () => {},
    trace: () => {},
    postCard: async (chatId, card) => { cards.push({ chatId, card }) },
  })
}

test('文件消息先发选择卡片，点输入文本后再携带文件进入 DSH', async () => {
  const state = makeState()
  const promptCalls = []
  const uploads = []
  const cards = []
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
  const inbound = makeInbound(ctx, state, cards)
  const fake = installFetch()

  try {
    await inbound.handle(fileEvent('om_file_1', 'file_key_1', 'report.txt'))

    assert.equal(promptCalls.length, 0)
    assert.equal(cards.length, 1)
    const id = choiceId(cards[0].card)
    assert.ok(id)
    assert.match(JSON.stringify(cards[0].card), /什么也不做/)
    assert.match(JSON.stringify(cards[0].card), /输入文本/)

    const answer = await inbound.handleCardAction(click(id, 'input'))
    assert.match(answer.toast.content, /下一条消息/)
    assert.equal(answer.card.type, 'raw')
    assert.match(JSON.stringify(answer.card.data), /等待文字说明/)

    await inbound.handle(textEvent('总结这个文件'))

    assert.equal(promptCalls.length, 1)
    assert.equal(promptCalls[0].sessionId, 'session_file_1')
    assert.equal(promptCalls[0].mode, 'queue')
    assert.equal(promptCalls[0].content[0].text, '总结这个文件')
    assert.deepEqual(promptCalls[0].content[1], { type: 'file', receiptId: 'receipt-file-1' })
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].name, 'report.txt')
    const chunks = []
    for await (const chunk of uploads[0].data) chunks.push(Buffer.from(chunk))
    assert.equal(Buffer.concat(chunks).toString(), 'hello file')
    assert.ok(fake.calls.some((call) => call.url.includes('om_file_1/resources/file_key_1') && call.url.includes('type=file')))
  } finally {
    fake.restore()
  }
})

test('多个文件都点什么也不做后，文字引用这些文件仍全部携带', async () => {
  const state = makeState()
  const promptCalls = []
  const uploads = []
  const cards = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return { prompt: async (request) => { promptCalls.push(request) } }
      }
      if (name === 'fileUploads') {
        return {
          uploadStream: async (request) => {
            const receiptId = `receipt-${uploads.length + 1}`
            uploads.push(request)
            return { receiptId, file: { bytes: 10 } }
          },
        }
      }
      return undefined
    },
  }
  const inbound = makeInbound(ctx, state, cards)
  const fake = installFetch()

  try {
    await inbound.handle(fileEvent('om_file_1', 'file_key_1', 'report.txt'))
    await inbound.handle(fileEvent('om_file_2', 'file_key_2', 'notes.txt'))
    assert.equal(cards.length, 2)
    assert.equal(promptCalls.length, 0)

    for (const card of cards) {
      const answer = await inbound.handleCardAction(click(choiceId(card.card), 'noop'))
      assert.match(answer.toast.content, /已忽略/)
      assert.equal(answer.card.type, 'raw')
    }

    await inbound.handle(textEvent('总结这两个文件', 'om_text_2', {
      parent_id: 'om_file_1',
      quote: { message_ids: ['om_file_1', 'om_file_2'] },
    }))

    assert.equal(promptCalls.length, 1)
    assert.equal(promptCalls[0].content[0].text, '总结这两个文件')
    const files = promptCalls[0].content.filter((part) => part.type === 'file')
    assert.equal(files.length, 2)
    assert.deepEqual(files.map((part) => part.receiptId), ['receipt-1', 'receipt-2'])
    assert.deepEqual(uploads.map((item) => item.name), ['report.txt', 'notes.txt'])
    assert.ok(fake.calls.some((call) => call.url.includes('om_file_1/resources/file_key_1')))
    assert.ok(fake.calls.some((call) => call.url.includes('om_file_2/resources/file_key_2')))
  } finally {
    fake.restore()
  }
})

test('直接回复文件消息时即使没点卡片也携带文件', async () => {
  const state = makeState()
  const promptCalls = []
  const uploads = []
  const cards = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') return { prompt: async (request) => { promptCalls.push(request) } }
      if (name === 'fileUploads') {
        return {
          uploadStream: async (request) => {
            const receiptId = `receipt-${uploads.length + 1}`
            uploads.push(request)
            return { receiptId, file: { bytes: 10 } }
          },
        }
      }
      return undefined
    },
  }
  const inbound = makeInbound(ctx, state, cards)
  const fake = installFetch()

  try {
    await inbound.handle(fileEvent('om_file_reply_1', 'file_key_reply_1', 'LAYOUT.md'))
    assert.equal(cards.length, 1)
    assert.equal(promptCalls.length, 0)

    // 飞书“回复消息”会在新消息上带 parent_id 指向被回复的文件消息。
    await inbound.handle(textEvent('这是什么', 'om_text_reply_1', {
      parent_id: 'om_file_reply_1',
      root_id: 'om_file_reply_1',
    }))

    assert.equal(promptCalls.length, 1)
    assert.equal(promptCalls[0].content[0].text, '这是什么')
    const files = promptCalls[0].content.filter((part) => part.type === 'file')
    assert.equal(files.length, 1)
    assert.deepEqual(files[0], { type: 'file', receiptId: 'receipt-1' })
    assert.deepEqual(uploads.map((item) => item.name), ['LAYOUT.md'])
    assert.ok(fake.calls.some((call) => call.url.includes('om_file_reply_1/resources/file_key_reply_1')))
  } finally {
    fake.restore()
  }
})

test('重启后回复旧消息也能按 ID 回查并携带文件与图片', async () => {
  const state = makeState()
  const promptCalls = []
  const uploads = []
  const cards = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') return { prompt: async (request) => { promptCalls.push(request) } }
      if (name === 'fileUploads') {
        return {
          uploadStream: async (request) => {
            const receiptId = `receipt-${uploads.length + 1}`
            uploads.push(request)
            return { receiptId, file: { bytes: 10 } }
          },
        }
      }
      return undefined
    },
  }
  const inbound = makeInbound(ctx, state, cards)
  const fake = installFetch()

  try {
    // 模拟插件重启：没有先收到文件事件，只有一条回复旧消息的文本。
    await inbound.handle(textEvent('这是什么？给我整理这个文件', 'om_text_old_reply_1', {
      parent_id: 'om_file_old',
      quote: { message_ids: ['om_file_old', 'om_image_old'] },
    }))

    assert.equal(promptCalls.length, 1)
    assert.equal(promptCalls[0].content[0].text, '这是什么？给我整理这个文件')
    const files = promptCalls[0].content.filter((part) => part.type === 'file')
    assert.equal(files.length, 1)
    assert.deepEqual(files[0], { type: 'file', receiptId: 'receipt-1' })
    assert.deepEqual(uploads.map((item) => item.name), ['LAYOUT.md'])
    const images = promptCalls[0].content.filter((part) => part.type === 'image')
    assert.equal(images.length, 1)
    assert.ok(fake.calls.some((call) => call.url.includes('/messages/om_file_old') && !call.url.includes('/resources/')))
    assert.ok(fake.calls.some((call) => call.url.includes('/messages/om_image_old') && !call.url.includes('/resources/')))
    assert.ok(fake.calls.some((call) => call.url.includes('om_file_old/resources/file_key_old')))
    assert.ok(fake.calls.some((call) => call.url.includes('om_image_old/resources/image_key_old')))
  } finally {
    fake.restore()
  }
})

test('缺少 fileUploads 服务时输入文字后给出提示而不是静默丢失', async () => {
  const state = makeState()
  const promptCalls = []
  const cards = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') return { prompt: async (request) => { promptCalls.push(request) } }
      return undefined
    },
  }
  const inbound = makeInbound(ctx, state, cards)
  const fake = installFetch()

  try {
    await inbound.handle(fileEvent('om_file_1', 'file_key_1', 'report.txt'))
    await inbound.handleCardAction(click(choiceId(cards[0].card), 'input'))
    await inbound.handle(textEvent('总结这个文件'))

    assert.equal(promptCalls.length, 0)
    assert.ok(replyTexts(fake.calls).some((body) => body.includes('附件下载或上传失败')))
  } finally {
    fake.restore()
  }
})

test('文件夹消息与文件走同一套卡片流程，展开后携带真实文件', async () => {
  const state = makeState()
  const promptCalls = []
  const uploads = []
  const cards = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return { prompt: async (request) => { promptCalls.push(request) } }
      }
      if (name === 'fileUploads') {
        return {
          uploadStream: async (request) => {
            uploads.push(request)
            return { receiptId: 'receipt-folder-1', file: { bytes: 10 } }
          },
        }
      }
      return undefined
    },
  }
  const inbound = makeInbound(ctx, state, cards)
  const fake = installFetch()

  try {
    await inbound.handle(folderEvent('om_folder_1', 'folder_key_1', 'etc'))
    assert.equal(promptCalls.length, 0)
    assert.equal(cards.length, 1)
    const id = choiceId(cards[0].card)
    assert.ok(id)
    assert.match(JSON.stringify(cards[0].card), /etc/)

    await inbound.handleCardAction(click(id, 'input'))
    await inbound.handle(textEvent('整理这个文件夹'))

    assert.equal(promptCalls.length, 1)
    assert.match(promptCalls[0].content[0].text, /整理这个文件夹/)
    assert.deepEqual(promptCalls[0].content[1], { type: 'file', receiptId: 'receipt-folder-1' })
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].name, 'child.txt')
    assert.ok(fake.calls.some((call) => call.url.includes('/files/folder_key_1/folder') && call.url.includes('srctype=message')))
    assert.ok(fake.calls.some((call) => call.url.includes('om_folder_1/resources/child_key_1')))
  } finally {
    fake.restore()
  }
})
