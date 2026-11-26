import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyAppSetupTemplate, publicState, readState, stateFile, writeState } from '../lib/state.js'

test('状态写入 0600，读取补齐默认值，浏览器投影不泄露密钥', async () => {
  const original = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-feishu-mcp-test-'))
  process.env.DSH_HOME = home
  try {
    const saved = await writeState({
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh-1234-5678-9012-123456789012',
      appId: 'cli_test',
      appSecret: 'super-secret-value',
      enableInbound: true,
      allowedOpenIds: ['ou_one', ''],
      chatSessions: { oc_one: 'session-one' },
    })
    assert.equal(saved.domain, 'feishu')
    assert.equal(saved.sessionMode, 'perChat')
    assert.deepEqual(saved.allowedOpenIds, ['ou_one'])

    const raw = await readFile(stateFile(), 'utf8')
    assert.match(raw, /super-secret-value/)
    assert.match(raw, /abcdefgh-1234-5678-9012-123456789012/)

    const view = publicState(await readState())
    assert.equal(view.webhookMasked, '********9012')
    assert.equal(view.appSecretMasked, '********alue')
    assert.equal(view.appSecretConfigured, true)
    assert.ok(!JSON.stringify(view).includes('super-secret-value'))
    assert.ok(!JSON.stringify(view).includes('abcdefgh-1234-5678-9012-123456789012'))
    assert.deepEqual(view.chatSessions, { oc_one: 'session-one' })
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
    await rm(home, { recursive: true, force: true })
  }
})

test('首次配置应用机器人时套用模板，且不覆盖身份与密钥', () => {
  const previous = {
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh-1234-5678-9012-123456789012',
    allowedOpenIds: ['ou_mine'],
    ownerOpenId: 'ou_mine',
    homeChatId: 'oc_mine',
    chatSessions: { oc_mine: 'session-mine' },
  }
  const result = applyAppSetupTemplate(previous)
  assert.equal(result.applied, true)
  assert.equal(result.next.enableWebhook, false)
  assert.equal(result.next.enableInbound, true)
  assert.equal(result.next.webhookAtAll, false)
  assert.equal(result.next.sessionSwitchLimit, 10)
  assert.equal(result.next.answerTimeoutMinutes, 0)
  assert.equal(result.next.channelDefaultsApplied, true)
  assert.equal(result.next.webhookUrl, previous.webhookUrl)
  assert.deepEqual(result.next.allowedOpenIds, ['ou_mine'])
  assert.deepEqual(result.next.chatSessions, { oc_mine: 'session-mine' })

  const explicit = applyAppSetupTemplate({ ...previous, channelChoiceExplicit: true })
  assert.equal(explicit.applied, false)
  assert.equal(explicit.next.enableWebhook, undefined)
})
