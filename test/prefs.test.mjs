import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

function collectRoutes() {
  const routes = []
  const ctx = {
    logger: { warn() {} },
    effect() {},
    on() {},
    get() { return undefined },
    inject(names, callback) {
      if (names.includes('connection')) {
        callback({
          connection: { fetch: { register(route) { routes.push(route) } } },
          effect(fn) { fn() },
        })
      } else {
        callback({ tools: { register() {} } })
      }
    },
  }
  apply(ctx)
  return routes
}

test('/prefs 保存完全权限，不回退到工作区读写', async () => {
  const originalHome = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'dsh-feishu-mcp-prefs-'))
  mkdirSync(join(home, 'dsh-feishu-mcp'), { recursive: true })
  const stateFile = join(home, 'dsh-feishu-mcp', 'state.json')
  writeFileSync(stateFile, JSON.stringify({ version: 3, defaultPermission: 'workspace', webhookUrl: '' }))
  process.env.DSH_HOME = home

  try {
    const routes = collectRoutes()
    const route = routes.find((item) => item.path === '/api/feishu-mcp/prefs')
    assert.ok(route, '应注册 /api/feishu-mcp/prefs 路由')

    const response = await route.fetch(new Request('http://localhost/api/feishu-mcp/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultPermission: 'full' }),
    }))
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.state.defaultPermission, 'full')
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).defaultPermission, 'full')
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
  }
})
