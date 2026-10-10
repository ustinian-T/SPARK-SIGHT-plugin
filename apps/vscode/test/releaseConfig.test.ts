import { describe, expect, it } from 'vitest'
import { validateReleaseConfig } from '../src/releaseConfig'
import { sourceDocument } from '../src/nativeSource'

describe('release endpoint configuration', () => {
  it('accepts public HTTPS origins and normalizes trailing slash', () => {
    expect(validateReleaseConfig({accountOrigin:'https://accounts.example.org/'}).accountOrigin).toBe('https://accounts.example.org')
  })
  it('rejects credentials, paths, non-HTTPS and unknown secret fields', () => {
    for (const accountOrigin of ['http://example.org','https://user:password@example.org','https://example.org/api','https://example.org/?key=value']) {
      expect(() => validateReleaseConfig({accountOrigin})).toThrow()
    }
    expect(() => validateReleaseConfig({accountOrigin:'https://example.org', apiKey:'secret'})).toThrow()
  })
})
describe('native source documents', () => {
  it('opens generated Python and R as editable native documents', () => {
    expect(sourceDocument({engine:'python',source:'print(1)'})).toEqual({language:'python',content:'print(1)'})
    expect(sourceDocument({engine:'r',source:'plot(1)'}).language).toBe('r')
  })
  it('rejects unsupported languages and oversized payloads', () => {
    expect(() => sourceDocument({engine:'shell',source:'cmd'})).toThrow()
    expect(() => sourceDocument({engine:'python',source:'x'.repeat(2000001)})).toThrow()
  })
})
