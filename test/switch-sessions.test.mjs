import test from 'node:test'
import assert from 'node:assert/strict'

import { createInbound } from '../lib/inbound-full.js'

function makeState(overrides = {}) {
  return {
    version: 3,
    appId: 'cli_test',
    appSecret: 'secret_test',
    domain: 'feishu',
    enableInbound: true,
    allowedOpenIds: ['ou_user_1'],
    ownerOpenId: '',
    homeChatId: '',
    chatSessions: {},
    allowCommands: true,
    inboundReply: true,
    sessionSwitchLimit: 3,
    sessionMode: 'perChat',
    trace: false,
    ...overrides,
  }
}

function switchEvent() {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user_1' } },
    message: {
      message_id: 'om_switch_1',
      chat_id: 'oc_chat_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '切换会话' }),
    },
  }
}

test('发送「切换会话」返回按钮卡片，按钮数量按 sessionSwitchLimit 配置', async () => {
  const state = makeState()
  const listed = []
  const cards = []
  const sessions = {
    list: async ({ query, limit }) => {
      listed.push({ query, limit })
      return Array.from({ length: 8 }, (_, index) => ({
        sessionId: `session_${index + 1}`,
        label: `会话 ${index + 1}`,
        updatedAt: Date.now() - index * 1000,
      }))
    },
    remember: () => {},
    current: async () => undefined,
    relativeTime: () => '刚刚',
  }
  const inbound = createInbound({
    ctx: { get: () => undefined },
    readState: async () => state,
    writeState: async (next) => ({ ...state, ...next }),
    log: () => {},
    trace: () => {},
    sessions,
    postCard: async (chatId, card) => {
      cards.push({ chatId, card })
      return { messageId: 'om_card_1' }
    },
  })

  await inbound.handle(switchEvent())

  assert.equal(listed.length, 1)
  assert.equal(listed[0].limit, 3)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].chatId, 'oc_chat_1')
  const buttons = cards[0].card.elements
    .filter((element) => element.tag === 'action')
    .flatMap((element) => element.actions)
    .filter((action) => action.tag === 'button')
  assert.equal(buttons.length, 3)
  assert.equal(buttons[0].value.k, 'resume')
  assert.match(cards[0].card.elements[0].content, /最多 3 个/)
})
