import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessions } from '../lib/sessions.js'

test('会话列表排除归档、子代理和隐藏会话', async () => {
  const items = [
    { sessionId: 'session_active', cwd: 'C:/project/a', projections: { values: { title: '正常会话' } }, updatedAt: 1 },
    { sessionId: 'session_archived', cwd: 'C:/project/b', archived: true, projections: { values: { title: '归档会话' } }, updatedAt: 2 },
    { sessionId: 'session_archived_at', cwd: 'C:/project/c', archivedAt: 123, projections: { values: { title: '归档会话二' } }, updatedAt: 3 },
    { sessionId: 'session_sub', cwd: 'C:/project/d', origin: 'subagent', projections: { values: { title: '子代理' } }, updatedAt: 4 },
    { sessionId: 'session_hidden', cwd: 'C:/project/e', hidden: true, projections: { values: { title: '隐藏' } }, updatedAt: 5 },
  ]
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return { list: async () => items }
      }
      return undefined
    },
  }
  const sessions = createSessions({ ctx, readState: async () => ({}), writeState: async (next) => next, trace: () => {} })

  const rows = await sessions.list({ limit: 20 })

  assert.deepEqual(rows.map((row) => row.sessionId), ['session_active'])
  assert.equal(rows[0].label, '正常会话')
})
