// 沙箱执行 / 错误分类 / 自动修复 / 产物验证测试（真实调用本机 Python）。
// 沙箱执行/安全扫描/错误签名/修复/独立验证测试（真实启动 Python）。
// 放宽沙箱超时，避免解释器冷启动或本机 CPU 争用导致的环境性误失败。
process.env.LOCAL_AGENT_SANDBOX_TIMEOUT_MS ??= '120000'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInSandbox, staticSafetyScan } from '../src/sandbox.js'
import { classifyError, repair, MAX_REPAIRS } from '../src/repair.js'
import { verifyPlan, verifyAllPlans } from '../src/verify.js'
import { generateCode, generateFallbackCode, expectedArtifacts } from '../src/codegen.js'
import { runDeterministicAnalysis } from '../src/stats.js'
import { buildPlans } from '../src/plans.js'
import { ingestFile } from '../src/csv.js'
import { probeEngines } from '../src/engines.js'
// 本机缺 pandas 时，与产品一致改用标准库 csv + matplotlib 降级模板（仍真实执行并验证）
const HAS_PANDAS = Boolean(probeEngines().python.dependencies?.pandas)

const here = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = fs.readFileSync(path.join(here, 'fixtures', 'nitrogen_response_demo.csv'))
const FILE_NAME = 'nitrogen_response_demo.csv'

function tmpWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-exec-test-'))
}

const ingest = ingestFile(FILE_NAME, SAMPLE)
const analysis = runDeterministicAnalysis({
  profile: ingest.profile,
  text: ingest.text.replace(/^﻿/, ''),
  rawDelimiter: ingest.rawDelimiter,
  fileName: FILE_NAME
})
const plans = buildPlans(analysis, { fileName: FILE_NAME, titleBase: '测试图', engine: 'python' })
const codegenInput = {
  fileName: FILE_NAME,
  x: analysis.summary.xLabel,
  measures: analysis.summary.series.map((s) => s.label),
  title: '测试图',
  yLabel: '测量值 (response)'
}

test('三套方案在真实 Python 沙箱中执行成功，产出合法 SVG/PNG（convention 另含 PDF）', async () => {
  for (const plan of plans) {
    const result = await runInSandbox({
      workdir: tmpWorkdir(),
      engine: 'python',
      code: HAS_PANDAS ? plan.code.python : generateFallbackCode(plan.strategy, codegenInput),
      csvBuffer: SAMPLE,
      csvName: FILE_NAME,
      expected: expectedArtifacts(plan.strategy, 'python')
    })
    assert.equal(result.status, 'success', `${plan.strategy} 应执行成功：${result.stderr}`)
    assert.equal(result.safetyViolations.length, 0)
    const svg = result.artifacts.find((a) => a.name.endsWith('.svg'))
    const png = result.artifacts.find((a) => a.name.endsWith('.png'))
    assert.ok(svg.svg.includes('<svg') && svg.svg.includes('</svg>'))
    assert.ok(png.png.width >= 320 && png.png.height >= 240)
    if (plan.strategy === 'convention') {
      assert.ok(result.artifacts.some((a) => a.name.endsWith('.pdf')), 'convention 应额外产出 PDF')
    }
    // 单方案独立验证（规格 + 证据）通过
    const v = verifyPlan(plan, result, {
      evidence: analysis.evidence,
      text: ingest.text.replace(/^﻿/, ''),
      rawDelimiter: ingest.rawDelimiter
    })
    for (const c of v.checks) assert.ok(c.passed, `${plan.strategy}/${c.name}: ${c.detail}`)
    assert.ok(v.passed)
  }
})

test('density 双面板 PNG 宽高比符合 1×2 布局代理校验', async () => {
  const plan = plans[2]
  const result = await runInSandbox({
    workdir: tmpWorkdir(),
    engine: 'python',
    code: HAS_PANDAS ? plan.code.python : generateFallbackCode(plan.strategy, codegenInput),
    csvBuffer: SAMPLE,
    csvName: FILE_NAME,
    expected: expectedArtifacts('density', 'python')
  })
  const png = result.artifacts.find((a) => a.name.endsWith('.png')).png
  assert.ok(png.width >= png.height * 1.6, `${png.width}x${png.height}`)
})

test('结构化三方案的时间×分组数据三套图均通过独立验证', async () => {
  const csvName = 'time-group-demo.csv'
  const csv = Buffer.from('时间,实验组别,响应指标\n第1周,对照组,2\n第1周,对照组,4\n第1周,处理组,5\n第1周,处理组,7\n第2周,对照组,6\n第2周,对照组,8\n第2周,处理组,10\n第2周,处理组,12\n')
  const ing = ingestFile(csvName, csv)
  const a = runDeterministicAnalysis({ profile: ing.profile, text: ing.text, rawDelimiter: ing.rawDelimiter, fileName: csvName })
  const structured = 'file=time-group-demo.csv x=时间 y=响应指标 group=实验组别 error=标准差 plans=3 plan1=user_request plan2=system_recommended plan3=system_recommended title=处理条件下响应指标趋势'
  const ps = buildPlans(a, { fileName: csvName, titleBase: structured, userRequest: structured, clarification: { chartType: 'line' } })
  const results = {}
  for (const p of ps) {
    results[p.plan_id] = await runInSandbox({ workdir: tmpWorkdir(), engine: 'python', code: p.code.python, csvBuffer: csv, csvName, expected: [`${p.plan_id}.png`, `${p.plan_id}.svg`] })
    assert.equal(results[p.plan_id].status, 'success', results[p.plan_id].stderr)
  }
  const v = verifyAllPlans(ps, results, { evidence: a.evidence, text: ing.text, rawDelimiter: ing.rawDelimiter })
  assert.equal(v.passed, true, JSON.stringify(v, null, 2))
  assert.deepEqual(ps.map(p => p.dataSuitability.chartType), ['line_error', 'box_plot', 'grouped_bar_error'])
})

test('静态安全扫描拦截违禁导入与调用', () => {
  assert.ok(staticSafetyScan('import os\nos.system("rm -rf /")', 'python').length > 0)
  assert.ok(staticSafetyScan('import subprocess\nsubprocess.run(["whoami"])', 'python').length > 0)
  assert.ok(staticSafetyScan('import requests\nrequests.get("http://x")', 'python').length > 0)
  assert.ok(staticSafetyScan('from socket import socket', 'python').length > 0)
  assert.deepEqual(staticSafetyScan('from mpl_toolkits.mplot3d import Axes3D', 'python'), [])
  assert.ok(staticSafetyScan('from mpl_toolkits.some_unsafe import X', 'python').length > 0)
  assert.ok(staticSafetyScan('import mpl_toolkits', 'python').length > 0)
  assert.ok(staticSafetyScan('library(httr)', 'r').length > 0)
  assert.ok(staticSafetyScan('download.file("http://x", "y")', 'r').length > 0)
  assert.ok(staticSafetyScan("system('whoami')", 'matlab').length > 0)
  assert.ok(staticSafetyScan("urlwrite('http://x','y')", 'matlab').length > 0)
  // 白名单内代码不被误伤
  assert.deepEqual(staticSafetyScan(plans[0].code.python, 'python'), [])
})

test('安全违规在沙箱中直接拒绝执行（不启动解释器）', async () => {
  const result = await runInSandbox({
    workdir: tmpWorkdir(),
    engine: 'python',
    code: 'import subprocess\nsubprocess.run(["calc.exe"])\n',
    csvBuffer: SAMPLE,
    csvName: FILE_NAME,
    expected: expectedArtifacts('clarity', 'python')
  })
  assert.equal(result.status, 'error')
  assert.ok(result.safetyViolations.length > 0)
  const c = classifyError(result)
  assert.equal(c.category, 'SAFETY')
  assert.equal(c.repairable, false)
  assert.equal(repair(c, { strategy: 'clarity', input: codegenInput, engine: 'python', attempt: 1 }), null)
})

test('无 pandas 降级模板真实可跑（仅标准库 csv + matplotlib）', async () => {
  const code = generateFallbackCode('clarity', { ...codegenInput, dpi: 100 })
  assert.ok(!/^\s*import pandas/m.test(code), '不应导入 pandas')
  assert.ok(!/^\s*import numpy/m.test(code), '不应导入 numpy')
  assert.ok(code.includes('import csv'))
  const result = await runInSandbox({
    workdir: tmpWorkdir(),
    engine: 'python',
    code,
    csvBuffer: SAMPLE,
    csvName: FILE_NAME,
    expected: expectedArtifacts('clarity', 'python')
  })
  assert.equal(result.status, 'success', result.stderr)
  assert.ok(result.artifacts.some((a) => a.name.endsWith('.svg')))
})

test('classifyError 七类签名归类正确', () => {
  const mk = (o) => ({ status: 'error', exitCode: 1, stdout: '', stderr: '', artifacts: [], missingArtifacts: [], ...o })
  assert.equal(classifyError(mk({ timedOut: true })).category, 'RESOURCE')
  assert.equal(classifyError(mk({ stderr: 'ModuleNotFoundError: No module named pandas' })).category, 'DEPENDENCY')
  assert.equal(classifyError(mk({ stderr: `KeyError: 'revenue'` })).category, 'FIELD')
  assert.equal(classifyError(mk({ stderr: '  File "plot.py", line 3\n    print(\nIndentationError: expected an indented block' })).category, 'SYNTAX')
  assert.equal(classifyError(mk({ stderr: 'python: command not found', spawnError: 'ENOENT' })).category, 'ENGINE')
  assert.equal(classifyError(mk({ stderr: 'License Manager Error -97' })).category, 'ENGINE')
  assert.equal(classifyError(mk({ stderr: 'savefig Permission denied' })).category, 'RENDER')
  assert.equal(classifyError(mk({ missingArtifacts: ['plan_clarity.svg'] })).category, 'RENDER')
  assert.equal(classifyError(mk({ safetyViolations: ['x'] })).category, 'SAFETY')
})

test('repair：DEPENDENCY(Python) 切降级模板；ENGINE(R) 切 Python；RESOURCE 降 dpi；禁止原样重试', () => {
  const dep = repair({ category: 'DEPENDENCY', signature: 'dependency.missing' }, { strategy: 'clarity', input: codegenInput, engine: 'python', attempt: 1 })
  assert.equal(dep.engine, 'python')
  assert.ok(!/^\s*import pandas/m.test(dep.code), '降级代码不应导入 pandas')
  assert.notEqual(dep.code, plans[0].code.python)

  const eng = repair({ category: 'ENGINE', signature: 'engine.not_found' }, { strategy: 'clarity', input: codegenInput, engine: 'r', attempt: 1 })
  assert.equal(eng.engine, 'python')
  assert.ok(eng.code.includes('matplotlib'))

  const res = repair({ category: 'RESOURCE', signature: 'resource.timeout' }, { strategy: 'clarity', input: { ...codegenInput, dpi: 160 }, engine: 'python', attempt: 1 })
  assert.equal(res.dpi, 100)
  const res2 = repair({ category: 'RESOURCE', signature: 'resource.timeout' }, { strategy: 'clarity', input: { ...codegenInput, dpi: 100 }, engine: 'python', attempt: 2 })
  assert.equal(res2.dpi, 80) // 不低于 80
})

test('修复预算为 3 次（初次执行加最多 3 次修复）', () => {
  assert.equal(MAX_REPAIRS, 3)
})

test('expectedArtifacts 声明与引擎/策略一致', () => {
  assert.deepEqual(expectedArtifacts('clarity', 'python'), ['plan_clarity.png', 'plan_clarity.svg'])
  assert.deepEqual(expectedArtifacts('convention', 'python'), ['plan_convention.png', 'plan_convention.svg', 'plan_convention.pdf'])
  assert.deepEqual(expectedArtifacts('density', 'r'), ['plan_density.png', 'plan_density.svg'])
  const code = generateCode('clarity', codegenInput)
  assert.ok(code.r.includes('plan_clarity.svg'))
  assert.ok(code.matlab.includes("print('-dsvg'"))
})
