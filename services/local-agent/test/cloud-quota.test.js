import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TenantCloudStore, DEFAULT_CLOUD_QUOTA_BYTES } from '../src/cloud.js'

test('每个账号默认300MB，边界与超额更新不会删除已有数据', () => {
  assert.equal(DEFAULT_CLOUD_QUOTA_BYTES, 300 * 1024 * 1024)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-quota-'))
  try {
    const store = new TenantCloudStore({ root })
    store.saveManifest('account_a', { projects: { project_a: { bytes: DEFAULT_CLOUD_QUOTA_BYTES - 1 } } })
    assert.doesNotThrow(() => store.assertQuota('account_a', 1))
    assert.throws(() => store.assertQuota('account_a', 2), error => error.status === 413 && error.code === 'CLOUD_QUOTA_EXCEEDED')
    assert.doesNotThrow(() => store.assertQuota('account_b', DEFAULT_CLOUD_QUOTA_BYTES))
    store.saveManifest('account_a', { projects: { project_a: { bytes: DEFAULT_CLOUD_QUOTA_BYTES + 100 } } })
    assert.throws(() => store.assertQuota('account_a', 1))
    assert.doesNotThrow(() => store.assertQuota('account_a', -100))
    assert.equal(store.manifest('account_a').projects.project_a.bytes, DEFAULT_CLOUD_QUOTA_BYTES + 100)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('拒绝超额上云时不留下占空间的暂存镜像', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-quota-staging-'))
  try {
    const source = path.join(root, 'source'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'data.csv'), 'group,value\na,1\n')
    const store = new TenantCloudStore({ root: path.join(root, 'cloud'), quotaBytes: 1 })
    assert.throws(() => store.archive('account_a', 'project_a', source), error => error.code === 'CLOUD_QUOTA_EXCEEDED')
    const accountRoot = path.join(store.root, 'account_a')
    assert.ok(!fs.existsSync(accountRoot) || fs.readdirSync(accountRoot).every(name => !name.includes('.staging-')))
    assert.equal(store.usage('account_a').usedBytes, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
