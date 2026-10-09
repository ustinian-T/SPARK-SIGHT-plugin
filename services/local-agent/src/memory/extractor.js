// 任务后抽取：从已验证任务结果中生成记忆候选，并做确定性去重、秘密扫描、隐私过滤。
// 抽取只产生「候选」，是否落盘由调用方确认（autoConfirm=false 时）。
import { tokenize } from './recall.js'

/**
 * 从任务结果抽取记忆候选（不写盘）。
 * @param {{fileName?:string, dataFingerprint?:string, userRequest?:string, selectedPlan?:object,
 *          palette?:object|string, runtime?:object, errors?:Array, userChoices?:object, outcome?:string}} taskResult
 * @returns {object[]} 候选记忆数组（未含 memoryId/createdAt 等，由 store 补齐）
 */
export function extractCandidates(taskResult = {}) {
  const candidates = []
  const { fileName, dataFingerprint, userRequest, selectedPlan, palette, errors, userChoices, outcome } = taskResult
  const success = outcome === 'success' || !outcome

  // 1. 配色偏好 → preference
  if (palette) {
    const paletteName = typeof palette === 'string' ? palette : (palette.name || palette.id || '未命名')
    candidates.push({
      type: 'preference',
      scope: 'global',
      summary: `用户偏好配色方案：${paletteName}`,
      retrievalTerms: ['配色', 'palette', '颜色', paletteName, ...tokenize(paletteName)],
      confidence: 0.7
    })
  }
  if (userChoices && typeof userChoices === 'object') {
    for (const [k, v] of Object.entries(userChoices)) {
      if (!v) continue
      candidates.push({
        type: 'preference',
        scope: 'global',
        summary: `用户在「${k}」上选择了：${String(v)}`,
        retrievalTerms: [k, String(v), ...tokenize(String(v))],
        confidence: 0.6
      })
    }
  }

  // 2. 成功工作流 → workflow
  if (success && selectedPlan) {
    const planKind = selectedPlan.kind || selectedPlan.type || selectedPlan.id || '绘图方案'
    candidates.push({
      type: 'workflow',
      scope: 'global',
      summary: `成功完成「${planKind}」类任务的工作流`,
      retrievalTerms: ['工作流', 'workflow', planKind, ...tokenize(planKind)],
      confidence: 0.6
    })
  }

  // 3. 数据集指纹 → dataset-schema
  if (dataFingerprint) {
    const fpShort = String(dataFingerprint).slice(0, 16)
    candidates.push({
      type: 'dataset-schema',
      scope: 'dataset',
      scopeRef: dataFingerprint,
      summary: `数据集「${fileName || '未命名'}」指纹 ${fpShort}…`,
      retrievalTerms: ['数据集', 'dataset', fileName || '', fpShort],
      confidence: 0.5
    })
  }

  // 4. 已验证错误 → error-pattern
  if (Array.isArray(errors) && errors.length > 0) {
    for (const err of errors) {
      const code = err.code || err.type || 'unknown'
      const msg = String(err.message || '').slice(0, 120)
      const resolution = err.resolution || err.fix || '已修复'
      candidates.push({
        type: 'error-pattern',
        scope: 'global',
        summary: `错误模式「${code}」：${msg}。处理方式：${resolution}`,
        retrievalTerms: ['错误', code, resolution, ...tokenize(msg)],
        confidence: 0.6
      })
    }
  }

  // 5. 最终方案选择 → outcome
  if (selectedPlan && userRequest) {
    const reqShort = String(userRequest).slice(0, 80)
    const planId = selectedPlan.id || selectedPlan.plan_id || 'unknown'
    candidates.push({
      type: 'outcome',
      scope: 'project',
      summary: `请求「${reqShort}」最终采用方案 ${planId}（${success ? '成功' : '未成功'}）`,
      retrievalTerms: ['结果', 'outcome', planId, ...tokenize(reqShort)],
      confidence: 0.5
    })
  }

  return candidates
}

/**
 * 计算两个字符串数组集合的 Jaccard 相似度。
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number} 0-1
 */
export function jaccardSimilarity(a, b) {
  const sa = new Set(a || [])
  const sb = new Set(b || [])
  if (sa.size === 0 && sb.size === 0) return 1
  const inter = new Set([...sa].filter((x) => sb.has(x)))
  const union = new Set([...sa, ...sb])
  return inter.size / union.size
}

/**
 * 确定性去重：同 type 且 retrievalTerms Jaccard > 0.8 视为重复。
 * 重复时返回 { isDuplicate: true, existing }，由调用方走 supersedes 更新链路。
 * @param {object[]} candidates 新抽取的候选
 * @param {object[]} existingMemories 已有 active 记忆
 * @returns {{candidate:object, isDuplicate:boolean, existing:object|null}[]}
 */
export function deterministicDedup(candidates, existingMemories) {
  const results = []
  for (const cand of candidates) {
    let dup = null
    for (const mem of existingMemories) {
      if (mem.status !== 'active') continue
      if (mem.type !== cand.type) continue
      const sim = jaccardSimilarity(cand.retrievalTerms, mem.retrievalTerms)
      if (sim > 0.8) { dup = mem; break }
    }
    results.push({ candidate: cand, isDuplicate: !!dup, existing: dup })
  }
  return results
}

// 秘密扫描正则：常见 API key / token / 密码 / 私钥模式
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,                              // OpenAI
  /ghp_[a-zA-Z0-9]{36}/,                              // GitHub PAT
  /gho_[a-zA-Z0-9]{36}/,
  /AKIA[0-9A-Z]{16}/,                                 // AWS Access Key
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /Bearer\s+[a-zA-Z0-9._-]{24,}/i,
  /api[_-]?key\s*[:=]\s*['"]?[a-zA-Z0-9]{16,}/i,
  /secret\s*[:=]\s*['"]?[a-zA-Z0-9]{16,}/i,
  /password\s*[:=]\s*['"]?[^\s'"]{6,}/i,
  /xox[baprs]-[a-zA-Z0-9-]{10,}/                     // Slack
]

/**
 * 秘密扫描：命中任一秘密模式返回 true（表示「含秘密，应拒绝写入」）。
 * @param {string} text
 * @returns {boolean}
 */
export function secretScan(text) {
  if (!text) return false
  const s = String(text)
  return SECRET_PATTERNS.some((re) => re.test(s))
}

/**
 * 隐私过滤：移除绝对路径中的用户名、IPv4 地址等敏感信息。
 * @param {string} text
 * @returns {string} 脱敏后的文本
 */
export function privacyFilter(text) {
  if (!text) return ''
  let s = String(text)
  // Windows 路径：C:\Users\<name> → C:\Users\<user>
  s = s.replace(/[A-Za-z]:\\Users\\[^\\\/\s]+/g, (m) => m.replace(/\\Users\\[^\\\/\s]+$/, '\\Users\\<user>'))
  // Unix 路径：/home/<name>、/Users/<name>
  s = s.replace(/\/(?:home|Users)\/[^\/\s]+/g, (m) => m.replace(/\/[^\/\s]+$/, '/<user>'))
  // IPv4 地址
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]')
  return s
}
