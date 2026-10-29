import test from 'node:test'
import assert from 'node:assert/strict'
import { accountServiceOrigin, validateReleaseConfig } from './lib/release-config.js'
const release = { accountOrigin: 'https://accounts.example.test', websiteOrigin: 'https://www.example.test', updateOrigin: 'https://updates.example.test' }
test('DSH uses the packaged account server by default and supports explicit overrides/local mode', () => {
  assert.equal(accountServiceOrigin({}, { env: {}, release }), release.accountOrigin)
  assert.equal(accountServiceOrigin({}, { env: { DEEP_IMAGING_ACCOUNT_URL: 'https://custom.example.test' }, release }), 'https://custom.example.test')
  assert.equal(accountServiceOrigin({ cloudAccountUrl: 'https://configured.example.test' }, { env: {}, release }), 'https://configured.example.test')
  assert.equal(accountServiceOrigin({ cloudAccountUrl: '' }, { env: {}, release }), '')
})
test('DSH refuses placeholder/malformed account endpoints and unexpected credential fields', () => {
  assert.throws(() => accountServiceOrigin({}, { env: {}, release: validateReleaseConfig() }), /账号服务/)
  for (const accountOrigin of ['http://accounts.example.test', 'https://user:fixture@accounts.example.test', 'https://accounts.example.test/private', 'https://accounts.example.test?token=fixture']) assert.throws(() => validateReleaseConfig({ accountOrigin }))
  assert.throws(() => validateReleaseConfig({ apiKey: 'fixture' }), /Unknown/)
})
