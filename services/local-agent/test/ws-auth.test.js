import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, openEvents, createTask } from './helpers.js'

test('WebSocket 认证流程', async () => {
  const h = await startTestServer()
  
  const { json } = await createTask(h, {
    csv: 'x,y\n1,2\n3,4',
    prompt: '绘制散点图',
    engine: 'python'
  })
  
  assert.ok(json.taskId, '应该返回 taskId')
  
  const conn = openEvents(h, json.taskId)
  
  await Promise.race([
    conn.opened,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('WebSocket 认证超时')), 3000)
    )
  ])
  
  assert.ok(true, 'WebSocket 认证成功')
  
  conn.close()
  await new Promise(r => setTimeout(r, 100))
  h.close()
})

test('WebSocket 无效 token 应被拒绝', async () => {
  const h = await startTestServer()
  
  const { json } = await createTask(h, {
    csv: 'x,y\n1,2',
    prompt: 'test',
    engine: 'python'
  })
  
  const conn = openEvents(h, json.taskId, { token: 'invalid-token-12345' })
  
  await assert.rejects(
    Promise.race([
      conn.opened,
      new Promise((_, reject) => {
        conn.ws.addEventListener('close', () => reject(new Error('连接被关闭')))
        setTimeout(() => reject(new Error('超时')), 3000)
      })
    ]),
    /连接被关闭/,
    '无效 token 应该导致连接关闭'
  )
  
  h.close()
})
