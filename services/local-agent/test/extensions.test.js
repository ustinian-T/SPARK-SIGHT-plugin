import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { CollaborationStore, PluginRegistry, RemoteNodeRegistry, generateTwoVariants, mergeText3 } from '../src/extensions.js'
import { buildExport } from '../src/export.js'
import { generateCodeForSpec } from '../src/codegen.js'
import { startTestServer, TOKEN } from './helpers.js'

function unzip(zip) {
  const files = {}
  let offset = 0
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8)
    const compressedSize = zip.readUInt32LE(offset + 18)
    const nameLength = zip.readUInt16LE(offset + 26)
    const extraLength = zip.readUInt16LE(offset + 28)
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const start = offset + 30 + nameLength + extraLength
    const data = zip.subarray(start, start + compressedSize)
    files[name] = method === 8 ? zlib.inflateRawSync(data) : data
    offset = start + compressedSize
  }
  return files
}

function planFixture() {
  return {
    plan_id: 'plan_clarity', name: '原方案', strategy: 'clarity', chartType: '折线图', evidenceIds: [],
    spec: {
      figure: { figure_id: 'figure_1', title: '原始标题', width: 6, height: 4 },
      panels: [{ panel_id: 'panel_1', xLabel: 'time', yLabel: 'value', layers: [{ layer_id: 'layer_1', kind: 'line', label: 'value', color: '#000000', x: [1, 2], y: [3, 4] }] }]
    },
    series: [{ label: 'value' }], code: { python: 'print(1)', r: 'print(1)', matlab: 'disp(1)' }, executionStatus: 'verified'
  }
}

test('plugin registries cover chart/style/engine/tool/data categories and accept safe metadata extension', () => {
  const registry = new PluginRegistry()
  registry.register('dataFormats', { id: 'json', name: 'JSON records', extensions: ['.json'] })
  const all = registry.list()
  for (const category of ['charts', 'styles', 'engines', 'tools', 'dataFormats']) assert.ok(all[category].length > 0)
  assert.throws(() => registry.register('charts', { id: '../bad', name: 'bad' }), /PLUGIN_INVALID|插件/)
})

test('one verified plan creates exactly two immutable review variants with regenerated code', () => {
  const source = planFixture()
  const task = { plans: [source], fileName: 'data.csv', dataset: { columns: [{ name: 'time', role: 'dimension' }, { name: 'value', role: 'measure' }] } }
  const variants = generateTwoVariants(task, source.plan_id)
  assert.equal(variants.length, 2)
  assert.equal(new Set(variants.map((item) => item.variantId)).size, 2)
  assert.ok(variants.every((item) => item.parentPlanId === source.plan_id && item.executionStatus === 'code_generated_not_executed'))
  assert.equal(source.spec.figure.title, '原始标题')
  assert.notEqual(variants[0].code.python, source.code.python)
})

test('histogram and boxplot are executable across Python, R and MATLAB code generators', () => {
  for (const kind of ['histogram', 'boxplot']) {
    const spec = { figure: { figure_id: 'f', title: kind }, panels: [{ panel_id: 'p', layers: [{ layer_id: 'l', kind }] }] }
    const code = generateCodeForSpec(spec, { fileName: 'data.csv', x: 'time', measures: ['value'], title: kind, yLabel: 'value', outputBase: kind })
    assert.match(code.python, kind === 'histogram' ? /\.hist\(/ : /\.boxplot\(/)
    assert.match(code.r, kind === 'histogram' ? /hist\(/ : /boxplot\(/)
    assert.match(code.matlab, kind === 'histogram' ? /histogram\(/ : /boxchart\(/)
  }
})

test('three-way merge auto-merges independent edits and marks per-line conflicts', () => {
  const clean = mergeText3('a\nb', 'A\nb', 'a\nB')
  assert.equal(clean.clean, true)
  assert.equal(clean.mergedText, 'A\nB')
  const conflict = mergeText3('a', 'interface', 'code')
  assert.equal(conflict.clean, false)
  assert.equal(conflict.conflicts[0].line, 1)
  assert.match(conflict.mergedText, /<<<<<<< INTERFACE/)
})

test('comments preserve target and validated significance metadata', () => {
  const store = new CollaborationStore()
  const comment = store.addComment('project_1', { userId: 'u1', displayName: '研究员' }, {
    text: '第三组与对照组差异显著', target: { kind: 'chart', id: 'panel_1' }, significance: { method: 'Welch t-test', pValue: 0.012, alpha: 0.05 }
  })
  assert.equal(comment.significance.significant, true)
  assert.equal(store.snapshot('project_1').comments.length, 1)
  assert.throws(() => store.addComment('project_1', { userId: 'u1' }, { text: 'bad', significance: { pValue: 2 } }), /SIGNIFICANCE_INVALID|显著性/)
})

test('remote nodes require secure endpoints and never expose credential values', async () => {
  process.env.TEST_REMOTE_R_TOKEN = 'super-secret'
  const registry = new RemoteNodeRegistry({ fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => ({ url }) }) })
  const node = registry.register({ engine: 'r', endpoint: 'https://compute.example.test', credentialEnv: 'TEST_REMOTE_R_TOKEN' })
  assert.equal(node.credentialConfigured, true)
  assert.equal(JSON.stringify(node).includes('super-secret'), false)
  assert.equal((await registry.check(node.nodeId)).lastHealth.ok, true)
  assert.throws(() => registry.register({ engine: 'matlab', endpoint: 'http://public.example.test' }), /REMOTE_NODE_INVALID|HTTPS/)
  delete process.env.TEST_REMOTE_R_TOKEN
})

test('advanced export settings can exclude data/code/evidence and record settings', () => {
  const plan = planFixture()
  const zip = buildExport({ title: 't', plans: [plan], evidence: [], bytes: Buffer.from('secret,data'), dataset: { rows: 1, cols: 1 }, artifacts: {} }, plan.plan_id, null, {
    includeCode: false, includeData: false, includeEvidence: false, includeArtifacts: false, dpi: 600, transparent: true, requestedFormats: ['svg']
  })
  assert.equal(zip.includes(Buffer.from('plot.py')), false)
  assert.equal(zip.includes(Buffer.from('data.csv')), false)
  assert.equal(zip.includes(Buffer.from('export-settings.json')), true)
  assert.equal(zip.includes(Buffer.from('reproducibility.json')), true)
  assert.equal(zip.includes(Buffer.from('data-processing.json')), true)
  assert.equal(zip.includes(Buffer.from('suitability-audit.json')), true)
  assert.equal(zip.includes(Buffer.from('quality-report.json')), true)
  const manifest = JSON.parse(unzip(zip)['manifest.json'])
  assert.equal(manifest.schema, 'deep-imaging.export-manifest.v1')
  assert.ok(manifest.files.some((file) => file.path === 'ChartSpec.json' && file.sha256.length === 64))
  const reproducibility = JSON.parse(unzip(zip)['reproducibility.json'])
  assert.equal(reproducibility.schema, 'deep-imaging.reproducibility.v1')
  assert.equal(reproducibility.sourceSha256.python.length, 64)
  assert.equal(reproducibility.exportSettings.dpi, 600)
  assert.equal(JSON.parse(unzip(zip)['export-settings.json']).dpi, 600)
})

test('导出修订校验发现代码哈希不匹配时不把旧图伪装成当前修订产物', () => {
  const plan = planFixture()
  plan.verification = { passed: true, engine: 'python', codeHash: 'stale-code-hash', artifactHash: 'old-artifact-hash' }
  const task = {
    taskId: 'task_revision', currentRevision: 3, plans: [plan], evidence: [], bytes: Buffer.from('x'),
    dataset: { rows: 1, cols: 1, fingerprint: 'current-dataset' },
    artifacts: { [plan.plan_id]: { hash: 'old-artifact-hash', inline: { svg: '<svg>old</svg>' } } }
  }
  const files = unzip(buildExport(task, plan.plan_id, null, { requestedFormats: ['svg'] }))
  assert.equal(files['artifacts/plan_clarity.svg'], undefined)
  const quality = JSON.parse(files['quality-report.json'])
  assert.equal(quality.schema, 'deep-imaging.quality-report.v2')
  assert.equal(quality.passed, false)
  assert.equal(quality.status, 'stale_version_artifacts_omitted')
  assert.equal(quality.versionBinding.verifiedCodeMatches, false)
})

test('extension HTTP endpoints expose registries, merge and project comments', async () => {
  const h = await startTestServer()
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  try {
    const plugins = await fetch(`${h.base}/api/plugins`, { headers }).then((response) => response.json())
    assert.ok(plugins.registries.charts.length > 0)
    const merge = await fetch(`${h.base}/api/merge`, { method: 'POST', headers, body: JSON.stringify({ base: 'a\nb', current: 'A\nb', incoming: 'a\nB' }) }).then((response) => response.json())
    assert.equal(merge.mergedText, 'A\nB')
    const created = await fetch(`${h.base}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ name: '协作项目' }) }).then((response) => response.json())
    const projectId = created.project.projectId
    const comment = await fetch(`${h.base}/api/projects/${projectId}/comments`, { method: 'POST', headers, body: JSON.stringify({ text: '请复核图 1', target: { kind: 'figure', id: 'figure_1' } }) }).then((response) => response.json())
    assert.match(comment.comment.commentId, /^comment_/)
    const snapshot = await fetch(`${h.base}/api/projects/${projectId}/comments`, { headers }).then((response) => response.json())
    assert.equal(snapshot.comments.length, 1)
  } finally { await h.close() }
})
