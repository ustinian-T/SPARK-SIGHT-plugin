// ClaimVerifier：自然语言结论发布前的独立证据门禁。
// 只接受引用存在证据、字段/样本范围一致且数值可在证据中找到的结构化结论。

function collectNumbers(value, output = []) {
  if (typeof value === 'number' && Number.isFinite(value)) output.push(value)
  else if (typeof value === 'string') {
    for (const match of value.matchAll(/[-+]?\d+(?:\.\d+)?/g)) output.push(Number(match[0]))
  } else if (Array.isArray(value)) value.forEach((item) => collectNumbers(item, output))
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectNumbers(item, output))
  return output
}

function numbersMatch(numbers, evidence, tolerance) {
  const actual = collectNumbers([evidence.value, evidence.details])
  return (numbers ?? []).every((expected) =>
    Number.isFinite(expected) && actual.some((value) => Math.abs(value - expected) <= tolerance)
  )
}

function fieldsMatch(fields, evidence) {
  const actual = new Set(evidence.fields ?? [])
  return (fields ?? []).every((field) => actual.has(field) || actual.has('*'))
}

export function verifyClaims(claims, ledger, tolerance = 1e-3) {
  const byId = new Map(ledger.map((item) => [item.evidence_id, item]))
  const accepted = []
  const rejected = []
  for (const claim of claims) {
    const evidence = byId.get(claim.evidenceId)
    let code = null
    if (!evidence) code = 'EVIDENCE_NOT_FOUND'
    else if (['causal', 'significance'].includes(claim.relation) && evidence.method == null) code = 'UNSUPPORTED_CAUSAL_LANGUAGE'
    else if (!fieldsMatch(claim.fields, evidence)) code = 'EVIDENCE_FIELD_MISMATCH'
    else if (claim.sampleScope !== evidence.scope) code = 'EVIDENCE_SCOPE_MISMATCH'
    else if (!numbersMatch(claim.numbers, evidence, tolerance)) code = 'EVIDENCE_VALUE_MISMATCH'

    if (code) rejected.push({ claim, code })
    else accepted.push(claim)
  }
  return { passed: rejected.length === 0, accepted, rejected }
}
