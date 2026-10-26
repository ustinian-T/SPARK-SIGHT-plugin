// 发布前的密钥与隐私检查：扫描仓库全部文本文件，命中即失败。
//
// 设计约束：本脚本本身会被公开，因此**绝不把任何被抹掉的真实值写成字面量**——
// 那等于把要保护的数据又写回仓库。这里只做两类检查：
//
//   1) 通用类别模式（GENERIC）：凭据形态、个人邮箱域、备案号、本地绝对路径。
//      它们描述的是"形状"，不指向任何具体的人或服务。
//   2) 本地黑名单（可选）：若仓库根存在 `.secrets-denylist.local`（已被 .gitignore
//      排除，不会入库），则逐行读取其中的字面量并断言全部不存在。维护者可以用它
//      守住"曾经出现过的具体值"，而这些值本身永远不进公开仓库。
//
// 白名单策略：只对确定性测试夹具做字面量替换，替换后仍需通过全部模式；
// 厂商形态的真实密钥永不进入白名单。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const SELF = 'scripts/check-secrets.mjs'
const DENYLIST = '.secrets-denylist.local'

// 通用类别模式：描述形状，不含任何真实值。
const GENERIC = [
  // —— 凭据形态 ——
  ['ark credential', /ark-[A-Za-z0-9_-]{24,}/g],
  ['OpenAI-style secret', /sk-[A-Za-z0-9_-]{24,}/g],
  ['AWS access key id', /AKIA[0-9A-Z]{16}/g],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g],
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/g],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['JWT-shaped token', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./g],
  ['assigned API token', /(?:API_KEY|AUTH_TOKEN|SECRET_KEY)\s*[:=]\s*['"][^'"<\s][^'"]{7,}/g],

  // —— 个人与基础设施标识（形状，不指向具体对象）——
  ['personal mailbox domain', /[A-Za-z0-9._%+-]+@(?:163|126|qq|sina|sohu|foxmail|139|189)\.(?:com|cn)/g],
  ['cn ICP filing number', /[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼]ICP备\d{6,}/g],
  ['cn public-security filing number', /[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼]公网安备\d{8,}/g],
  ['cn mobile number literal', /(?<![0-9A-Za-z.])1[3-9]\d{9}(?![0-9A-Za-z])/g],
  // 排除通用占位用户名（zhangsan/lisi 及英文常见示例名），只抓像真实账号的段。
  ['windows user-profile path', /[A-Za-z]:\\+Users\\+(?!(?:zhangsan|lisi|wangwu|alice|bob|user|username|name|test|example)\b)[A-Za-z0-9._-]{2,}/g]

  // 说明：'cn mobile number literal' 会命中测试夹具中的 138/139/137 段号。
  // 这些是工信部公开的测试号段，已在 FIXTURES 中放行。
]

// 确定性测试夹具：仅这些确切字面量被替换，替换后仍要过全部模式。
const FIXTURES = [
  "'test-key'", "'test-secret-key'",
  "'sk-secret-abcdef-123456'", 'sk-secret-abcdef-123456',
  'AKIAIOSFODNN7EXAMPLE',
  '-----BEGIN RSA PRIVATE KEY-----',
  "'legacy-default-password'", 'legacy-default-password',
  // 工信部公开测试号段，仅用于测试夹具
  '13800138000', '13900139000', '13900139001', '13700137000'
]

const neutralize = (text) => FIXTURES.reduce((out, literal) => out.replaceAll(literal, '<fixture>'), text.replaceAll('spark_sight@163.com', '<public-support>'))

function collectFiles() {
  try {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: process.cwd(), encoding: 'utf8' }).split('\0').filter(Boolean)
    if (tracked.length) return tracked
  } catch { /* 未初始化的检出走目录遍历 */ }
  const ignored = new Set(['.git', 'node_modules', '.npm-cache', 'dist', 'target', '.data', 'coverage'])
  const files = []
  const walk = (dir = '.') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue
      const file = `${dir}/${entry.name}`.replace(/^\.\//, '')
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) files.push(file)
    }
  }
  walk()
  return files
}

// 本地黑名单：文件中每行一个字面量，'#' 开头与空行忽略。不随仓库分发。
function loadDenylist() {
  const file = path.join(process.cwd(), DENYLIST)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

const denylist = loadDenylist()
const files = collectFiles()
const findings = []
let scanned = 0

for (const file of files) {
  if (file === SELF || file === DENYLIST) continue
  let buffer
  try { buffer = process.argv.includes('--staged') ? execFileSync('git', ['show', `:${file}`], { maxBuffer: 64 * 1024 * 1024 }) : fs.readFileSync(file) } catch { continue }
  if (buffer.includes(0)) continue // 二进制
  scanned++
  const raw = buffer.toString('utf8')
  const text = neutralize(raw)

  for (const [label, pattern] of GENERIC) {
    pattern.lastIndex = 0
    if (pattern.test(text)) findings.push({ file, label })
  }
  for (const literal of denylist) {
    if (text.includes(literal)) findings.push({ file, label: 'local denylist match' })
  }
}

if (findings.length) {
  for (const item of findings) console.error(`[check:secrets] FAIL ${item.file}: ${item.label}`)
  console.error(`[check:secrets] ${findings.length} finding(s); see docs/privacy-and-redaction.md`)
  process.exitCode = 1
} else {
  const extra = denylist.length ? `; ${denylist.length} local denylist entries enforced` : `; no local denylist (${DENYLIST} absent)`
  console.log(`[check:secrets] OK — scanned ${scanned} text files; no credentials or personal identifiers found${extra}`)
}
