import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUserProfile, mergeUserProfile } from '../src/userProfile.js'

test('profile whitelist rejects private content, invalid enums and unsafe IDs', () => {
  assert.deepEqual(normalizeUserProfile({ researchField: '  农学 ', labelLanguage: 'en', phone: 'secret', prompt: 'private', experienceLevel: 'wrong', paletteId: '../../oops' }), { researchField: '农学', labelLanguage: 'en' })
  assert.deepEqual(normalizeUserProfile(['en']), {})
})
test('explicit deletion and partial edits preserve other confirmed choices', () => {
  assert.deepEqual(mergeUserProfile({ labelLanguage: 'en', researchField: '农学', legendPosition: 'right' }, { labelLanguage: 'bilingual', researchField: null }), { labelLanguage: 'bilingual', legendPosition: 'right' })
})
