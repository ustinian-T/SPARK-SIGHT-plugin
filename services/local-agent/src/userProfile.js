// Only choices explicitly confirmed by the user belong to the account profile.
// Task prompts, data, answers and inferred behaviour are deliberately excluded.
export const USER_PROFILE_FIELDS = Object.freeze({
  researchField: null,
  experienceLevel: ['beginner', 'intermediate', 'advanced'],
  outputPurpose: ['paper', 'presentation', 'exploration', 'report'],
  labelLanguage: ['auto', 'zh', 'en', 'bilingual'],
  legendPosition: ['auto', 'top', 'bottom', 'right', 'inside'],
  paletteId: null,
  clarificationMode: ['guided', 'minimal', 'off']
})

export function normalizeUserProfile(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const profile = {}
  for (const [key, allowed] of Object.entries(USER_PROFILE_FIELDS)) {
    const value = input[key]
    if (typeof value !== 'string') continue
    const cleaned = value.trim()
    if (!cleaned || cleaned.length > (key === 'researchField' ? 120 : 64)) continue
    if (allowed && !allowed.includes(cleaned)) continue
    if (key === 'paletteId' && !/^[a-zA-Z0-9_-]+$/.test(cleaned)) continue
    profile[key] = cleaned
  }
  return profile
}

export function mergeUserProfile(current, patch) {
  const profile = normalizeUserProfile(current)
  const normalized = normalizeUserProfile(patch)
  for (const key of Object.keys(USER_PROFILE_FIELDS)) {
    if (patch?.[key] === null || patch?.[key] === '') delete profile[key]
    else if (Object.hasOwn(normalized, key)) profile[key] = normalized[key]
  }
  return profile
}

export function profileClarificationDefaults(input) {
  const profile = normalizeUserProfile(input)
  return Object.fromEntries(['labelLanguage', 'legendPosition', 'paletteId']
    .filter(key => profile[key]).map(key => [key, profile[key]]))
}
