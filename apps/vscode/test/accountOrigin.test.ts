import { describe, expect, it } from 'vitest'
import { accountServiceOrigin, validateReleaseConfig } from '../src/releaseConfig'
const release = { accountOrigin: 'https://accounts.example.test', websiteOrigin: 'https://www.example.test', updateOrigin: 'https://updates.example.test' }
describe('VS Code account service destination', () => {
  it('uses the packaged cloud endpoint and a valid explicit override', () => {
    expect(accountServiceOrigin('', release)).toBe(release.accountOrigin)
    expect(accountServiceOrigin('https://custom.example.test', release)).toBe('https://custom.example.test')
  })
  it('rejects unconfigured source builds and unsafe overrides explicitly', () => {
    expect(() => accountServiceOrigin('', validateReleaseConfig({}))).toThrow('账号服务')
    for (const origin of ['http://accounts.example.test', 'https://user:fixture@accounts.example.test', 'https://accounts.example.test/private']) expect(() => accountServiceOrigin(origin, release)).toThrow()
  })
})
