// 校验各客户端的协议声明与权威定义 contract/host-protocol.schema.json 保持一致。
// 本仓库只发布 web 与 vscode 两个客户端；桌面壳（apps/desktop）不在发布范围内。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const json = (...parts) => JSON.parse(read(...parts))
const sorted = (values) => [...values].sort()
const schema = json('contract', 'host-protocol.schema.json')

const declarations = {
  web: json('apps', 'web', 'src', 'host', 'protocol.json'),
  vscode: json('apps', 'vscode', 'src', 'protocol.json')
}

for (const [client, declaration] of Object.entries(declarations)) {
  assert.equal(declaration.protocolVersion, schema.protocolVersion, `${client} protocol version drifted`)
  assert.deepEqual(sorted(declaration.messageTypes), sorted(schema.messageTypes), `${client} message types drifted`)
  assert.deepEqual(sorted(declaration.agentStates), sorted(schema.agentStates), `${client} Agent states drifted`)
  assert.deepEqual(sorted(declaration.hostErrorCodes), sorted(schema.hostErrorCodes), `${client} host error codes drifted`)
}

function tsArray(source, name) {
  const match = source.match(new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`))
  assert.ok(match, `missing TypeScript declaration ${name}`)
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
}

const webHost = read('apps', 'web', 'src', 'host', 'types.ts')
const vscodeHost = read('apps', 'vscode', 'src', 'hostBridge.ts')
assert.deepEqual(sorted(tsArray(webHost, 'HOST_MESSAGE_TYPES')), sorted(schema.messageTypes), 'Web source message types drifted')
assert.deepEqual(sorted(tsArray(vscodeHost, 'HOST_MESSAGE_TYPES')), sorted(schema.messageTypes), 'VSCode source message types drifted')

const webTypes = read('apps', 'web', 'src', 'types', 'index.ts')
const stateUnion = webTypes.match(/export type AgentState\s*=([\s\S]*?)\r?\n\r?\n/)
assert.ok(stateUnion, 'missing Web AgentState')
assert.deepEqual(sorted([...stateUnion[1].matchAll(/'([^']+)'/g)].map((item) => item[1])), sorted(schema.agentStates), 'AgentState union drifted')

const errors = read('services', 'local-agent', 'src', 'errors.js')
const errorObject = errors.match(/export const ERR = \{([\s\S]*?)\n\}/)
assert.ok(errorObject, 'missing backend ERR declaration')
assert.deepEqual(sorted([...errorObject[1].matchAll(/:\s*'([^']+)'/g)].map((item) => item[1])), sorted(schema.backendErrorCodes), 'backend error codes drifted')

const exportSource = read('services', 'local-agent', 'src', 'export.js')
for (const name of schema.requiredExportContents) assert.ok(exportSource.includes(name), `required export content missing: ${name}`)

console.log(`[check:contract] OK — ${Object.keys(declarations).length} clients, protocol v${schema.protocolVersion}, ${schema.messageTypes.length} message types, ${schema.agentStates.length} states`)
