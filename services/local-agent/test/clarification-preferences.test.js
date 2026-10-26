import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePresentation, parseChartType, chartTypeQuestion, runClarification, presentationQuestion } from '../src/clarify.js'
import { buildPlans } from '../src/plans.js'
import { ingestFile } from '../src/csv.js'
import { runDeterministicAnalysis } from '../src/stats.js'
import { runInSandbox } from '../src/sandbox.js'
import { TaskStore } from '../src/taskStore.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('presentation offers independent language and legend choices and parses them', () => {
  assert.ok(presentationQuestion().choiceGroups?.some(group => group.key === 'labelLanguage'))
  assert.deepEqual(parsePresentation('标注语言=英文；图例位置=图外右侧').labelLanguage, 'en')
  assert.equal(parsePresentation('标注语言=英文；图例位置=图外右侧').legendPosition, 'right')
  assert.equal(parsePresentation('标注语言=恶意值；图例位置=恶意值').legendPosition, undefined)
  assert.equal(parsePresentation('标注语言=__proto__；图例位置=constructor').labelLanguage, undefined)
})

test('language and legend change display spec and generated source while source fields stay intact', () => {
  const input = ingestFile('demo.csv', Buffer.from('周次,产量\n1,12\n2,15\n3,14\n4,19\n'))
  const analysis = runDeterministicAnalysis({ profile: input.profile, text: input.text, rawDelimiter: input.rawDelimiter, fileName: 'demo.csv' })
  const plans = buildPlans(analysis, { fileName: 'demo.csv', titleBase: '产量', clarification: { labelLanguage: 'en', legendPosition: 'right' } })
  for (const plan of plans) {
    assert.equal(plan.spec.panels[0].legend.position, 'right')
    assert.equal(plan.spec.figure.title, 'Yield')
    assert.equal(plan.spec.panels[0].scales.find(scale => scale.axis === 'x').label, 'Week')
    assert.match(plan.code.python, /bbox_to_anchor=\(1\.02, 0\.5\)/)
    assert.match(plan.code.python, /周次/)
    assert.match(plan.code.r, /xlab = "Week"/)
    assert.match(plan.code.matlab, /'Location', 'eastoutside'/)
  }
})

test('saved profile supplies presentation defaults without skipping task questions or saving task answers', async () => {
  const profile = { labelLanguage: 'en', legendPosition: 'bottom', paletteId: 'user_nature' }
  const asked = []
  const result = await runClarification({}, { context: { userProfile: profile }, ask: async (round, question) => {
    asked.push(question)
    return round === 3 ? '图例位置=图内右上角' : '默认'
  } })
  assert.equal(asked.length, 3)
  assert.equal(result.labelLanguage, 'en')
  assert.equal(result.legendPosition, 'inside')
  assert.deepEqual(profile, { labelLanguage: 'en', legendPosition: 'bottom', paletteId: 'user_nature' })
})

test('chosen English labels produce a real SVG while preserving Chinese CSV fields', async () => {
  const csv = Buffer.from('周次,产量\n1,12\n2,15\n3,14\n4,19\n')
  const input = ingestFile('demo.csv', csv)
  const analysis = runDeterministicAnalysis({ profile: input.profile, text: input.text, rawDelimiter: input.rawDelimiter, fileName: 'demo.csv' })
  const [plan] = buildPlans(analysis, { fileName: 'demo.csv', titleBase: '产量', clarification: { labelLanguage: 'en', legendPosition: 'right' } })
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-render-'))
  const result = await runInSandbox({ workdir, engine: 'python', code: plan.code.python, csvBuffer: csv, csvName: 'demo.csv', expected: ['plan_clarity.svg', 'plan_clarity.png'] })
  assert.equal(result.status, 'success', result.stderr)
  assert.match(result.artifacts.find(item => item.name.endsWith('.svg')).svg, /Yield|Week/)
})

test('chart options explicitly offer grouped bars with error bars', () => {
  assert.ok(chartTypeQuestion().options.some(option => option.includes('分组柱状') && option.includes('误差棒')))
  assert.equal(parseChartType('分组柱状图（均值+误差棒）').chartType, 'grouped_bar')
  assert.equal(parseChartType('grouped_bar').chartType, 'grouped_bar')
})

test('minimal clarification asks the analysis goal and reuses confirmed display defaults', async () => {
  const asked = []
  const result = await runClarification({}, { context: { userProfile: { clarificationMode: 'minimal', labelLanguage: 'bilingual', legendPosition: 'top' } }, ask: async round => { asked.push(round); return '分布与离群情况' } })
  assert.deepEqual(asked, [1])
  assert.equal(result.goal, 'distribution')
  assert.equal(result.labelLanguage, 'bilingual')
  assert.equal(result.legendPosition, 'top')
})

test('demo data nature is explicit, bounded, and preserved in task snapshots', () => {
  const store = new TaskStore({ ttlMs: 0 })
  const task = store.create({
    title: '虚拟科研绘图演示',
    engine: 'python',
    prompt: '展示六周趋势',
    fileName: '01_实验观测数据.csv',
    bytes: Buffer.from('时间,实验组别,响应指标\n第1周,对照组,10\n', 'utf-8'),
    dataNature: 'synthetic_demo',
    dataDisclosure: '构造数据，仅用于功能演示，不代表真实科研结论'
  })
  const snapshot = store.snapshot(task)
  assert.equal(snapshot.dataNature, 'synthetic_demo')
  assert.match(snapshot.dataDisclosure, /不代表真实科研结论/)
  const invalid = store.create({ title: 'unknown', engine: 'python', prompt: '', fileName: 'x.csv', bytes: Buffer.from('x\n1\n'), dataNature: 'not_allowed' })
  assert.equal(store.snapshot(invalid).dataNature, 'unknown')
})
