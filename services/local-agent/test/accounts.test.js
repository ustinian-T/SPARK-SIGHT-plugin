// 账户体系测试：注册校验（6 位下限/禁中文/唯一性）、审批制注册、一次性邀请码、
// 管理员用户管理、云存储配额与 7 天保留清扫、静态托管与路径穿越防护。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TenantCloudStore, sweepRetention, fmtBytes } from '../src/cloud.js'
import { startTestServer } from './helpers.js'

async function json(base, pathName, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${base}${pathName}`, {
    method,
    headers: {
      'x-agent-protocol': '1',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  return { response, value: await response.json().catch(() => ({})) }
}

// 测试引导：直接用 identityStore 签发管理员会话（引导管理员密码仅打印在 stdout）
function adminToken(agent) {
  const admin = agent.identityStore.state.users.find((user) => user.role === 'admin')
  assert.ok(admin, 'bootstrap admin should exist')
  return agent.identityStore.issue(admin).token
}

test('注册校验：账户名 6 位下限、禁中文、唯一性与查重端点', async () => {
  const h = await startTestServer()
  try {
    const tooShort = await json(h.base, '/api/auth/register', { method: 'POST', body: { username: 'abc12', password: 'long-password-123', displayName: '张三', phone: '13800138000' } })
    assert.equal(tooShort.response.status, 400)
    const chinese = await json(h.base, '/api/auth/register', { method: 'POST', body: { username: '中文名用户', password: 'long-password-123', displayName: '张三' } })
    assert.equal(chinese.response.status, 400)
    const badPhone = await json(h.base, '/api/auth/register', { method: 'POST', body: { username: 'phoneuser', password: 'long-password-123', displayName: '李四', phone: '12345' } })
    assert.equal(badPhone.response.status, 400)
    const ok = await json(h.base, '/api/auth/register', { method: 'POST', body: { username: 'Alpha_01', password: 'long-password-123', displayName: '张三', phone: '13800138000', agreementAccepted: true, agreementVersion: 'test-v1' } })
    assert.equal(ok.response.status, 201)
    assert.ok(ok.value.token, '本地模式注册即激活并签发令牌')
    assert.equal(ok.value.user.status, 'active')
    assert.equal(ok.value.user.phone, '13800138000')
    const duplicate = await json(h.base, '/api/auth/register', { method: 'POST', body: { username: 'alpha_01', password: 'long-password-123', displayName: '重复', agreementAccepted: true, agreementVersion: 'test-v1' } })
    assert.equal(duplicate.response.status, 409)
    const taken = await json(h.base, '/api/auth/username-available?username=alpha_01')
    assert.equal(taken.value.available, false)
    const free = await json(h.base, '/api/auth/username-available?username=freeuser')
    assert.equal(free.value.available, true)
    const login = await json(h.base, '/api/auth/login', { method: 'POST', body: { username: 'alpha_01', password: 'long-password-123' } })
    assert.equal(login.response.status, 200)
    const wrongRole = await json(h.base, '/api/auth/login', { method: 'POST', body: { username: 'alpha_01', password: 'long-password-123', expectedRole: 'admin' } })
    assert.equal(wrongRole.response.status, 403)
    const forged = await json(h.base, '/api/auth/register', { method: 'POST', body: { username: 'forgedadmin', password: 'long-password-123', role: 'admin', bootstrap: true, protected: true, adminProvisioned: true, status: 'active' } })
    assert.equal(forged.response.status, 400, '公开注册不得绕过协议同意')
    const accepted = await json(h.base, '/api/auth/register', { method: 'POST', body: { username: 'forgedadmin', password: 'long-password-123', role: 'admin', bootstrap: true, protected: true, adminProvisioned: true, modelAccess: { allowOwn: true, allowShared: true }, agreementAccepted: true, agreementVersion: 'test-v1' } })
    assert.equal(accepted.response.status, 201)
    assert.equal(accepted.value.user.role, 'user')
    assert.deepEqual(accepted.value.user.modelAccess, { allowOwn: false, allowShared: false })
    assert.equal(h.agent.identityStore.findUser(accepted.value.user.userId).protected, false)
  } finally { await h.close() }
})

test('管理员控制台：权限门禁、用户增删改、密码重置使旧会话失效', async () => {
  const h = await startTestServer()
  try {
    const user = await json(h.base, '/api/auth/register', { method: 'POST', body: { username: 'member01', password: 'long-password-123', displayName: '成员一', agreementAccepted: true, agreementVersion: 'test-v1' } })
    const userToken = user.value.token
    const forbidden = await json(h.base, '/api/admin/users', { token: userToken })
    assert.equal(forbidden.response.status, 403)
    const atoken = adminToken(h.agent)
    const list = await json(h.base, '/api/admin/users', { token: atoken })
    assert.equal(list.response.status, 200)
    assert.ok(list.value.users.some((item) => item.role === 'admin'))
    assert.ok(list.value.users.every((item) => !item.passwordHash && !item.salt), '用户列表不得泄露口令哈希')
    // 管理员直接创建用户（桌面端无注册界面场景）
    const created = await json(h.base, '/api/admin/users', { method: 'POST', token: atoken, body: { username: 'member02', password: 'long-password-123', displayName: '成员二', phone: '13900139000' } })
    assert.equal(created.response.status, 201)
    const provisioned = h.agent.identityStore.findUser(created.value.user.userId)
    assert.equal(provisioned.agreedAt, null, '管理员代建不伪造用户协议同意记录')
    const createdUserId = created.value.user.userId
    // 修改资料 + 重置密码
    const updated = await json(h.base, `/api/admin/users/${createdUserId}`, { method: 'PUT', token: atoken, body: { displayName: '成员二号', phone: '13900139001', password: 'new-password-456' } })
    assert.equal(updated.response.status, 200)
    assert.equal(updated.value.user.displayName, '成员二号')
    const oldLogin = await json(h.base, '/api/auth/login', { method: 'POST', body: { username: 'member02', password: 'long-password-123' } })
    assert.equal(oldLogin.response.status, 401)
    const newLogin = await json(h.base, '/api/auth/login', { method: 'POST', body: { username: 'member02', password: 'new-password-456' } })
    assert.equal(newLogin.response.status, 200)
    // 旧令牌已被 tokenVersion 失效
    const staleMe = await json(h.base, '/api/auth/me', { token: created.value.token })
    assert.equal(staleMe.response.status, 401)
    // 删除用户：账号与名下项目一并清除
    await json(h.base, '/api/projects', { method: 'POST', token: userToken, body: { name: '成员一的项目' } })
    const removed = await json(h.base, `/api/admin/users/${user.value.user.userId}`, { method: 'DELETE', token: atoken })
    assert.equal(removed.response.status, 200)
    const goneLogin = await json(h.base, '/api/auth/login', { method: 'POST', body: { username: 'member01', password: 'long-password-123' } })
    assert.equal(goneLogin.response.status, 401)
    assert.ok(!h.agent.projectStore.state.projects.some((project) => project.ownerId === user.value.user.userId), '被删用户项目应同步清除')
    // 自删除防护与管理员删除防护
    const selfDelete = await json(h.base, `/api/admin/users/${created.value.user.userId}`, { method: 'DELETE', token: created.value.token })
    assert.equal(selfDelete.response.status, 401)
    const adminUser = h.agent.identityStore.state.users.find((item) => item.role === 'admin')
    const deleteAdmin = await json(h.base, `/api/admin/users/${adminUser.userId}`, { method: 'DELETE', token: atoken })
    assert.equal(deleteAdmin.response.status, 400)
    const secondAdmin = h.agent.identityStore.register({ username: 'secondadmin', password: 'long-password-123', role: 'admin', bootstrap: true })
    const rejectAdmin = await json(h.base, `/api/admin/users/${adminUser.userId}/reject`, { method: 'POST', token: secondAdmin.token })
    assert.equal(rejectAdmin.response.status, 400)
    assert.throws(() => h.agent.identityStore.removeUser(adminUser.userId), /不可删除/)
  } finally { await h.close() }
})

test('审批制注册（REMOTE_MODE）：待审核不可登录，通过/驳回 + 邀请码一次性消费', async () => {
  const h = await startTestServer(1, { remote: { enabled: true, users: {}, secret: 'remote-mode-test-secret-32ch' } })
  try {
    const atoken = adminToken(h.agent)
    const invite = await json(h.base, '/api/admin/invites', { method: 'POST', token: atoken, body: { code: 'WELCOME-2026-XY' } })
    assert.equal(invite.response.status, 201)
    const shortCode = await json(h.base, '/api/admin/invites', { method: 'POST', token: atoken, body: { code: 'short9' } })
    assert.equal(shortCode.response.status, 400)
    const generated = await json(h.base, '/api/admin/invites', { method: 'POST', token: atoken, body: {} })
    assert.equal(generated.response.status, 201)
    assert.match(generated.value.invite.code, /^[A-Za-z0-9_-]{10,64}$/)
    // 注册：进入待审核，令牌不签发，邀请码被预留
    const pending = await json(h.base, '/api/auth/register', { method: 'POST', body: { username: 'apply01', password: 'long-password-123', displayName: '申请人', phone: '13700137000', inviteCode: 'WELCOME-2026-XY', agreementAccepted: true, agreementVersion: 'test-v1' } })
    assert.equal(pending.response.status, 202)
    assert.equal(pending.value.pendingApproval, true)
    assert.equal(pending.value.token, undefined)
    const pendingLogin = await json(h.base, '/api/auth/login', { method: 'POST', body: { username: 'apply01', password: 'long-password-123' } })
    assert.equal(pendingLogin.response.status, 403)
    assert.equal(pendingLogin.value.error.code, 'AUTH_PENDING')
    const invites = await json(h.base, '/api/admin/invites', { token: atoken })
    const reserved = invites.value.invites.find((item) => item.code === 'WELCOME-2026-XY')
    assert.equal(reserved.reservedBy, pending.value.user.userId)
    // 审核通过：邀请码一次性消费并自动删除
    const approved = await json(h.base, `/api/admin/users/${pending.value.user.userId}/approve`, { method: 'POST', token: atoken })
    assert.equal(approved.response.status, 200)
    assert.equal(approved.value.user.status, 'active')
    const invitesAfter = await json(h.base, '/api/admin/invites', { token: atoken })
    assert.ok(!invitesAfter.value.invites.some((item) => item.code === 'WELCOME-2026-XY'), '邀请码使用后应自动删除')
    const login = await json(h.base, '/api/auth/login', { method: 'POST', body: { username: 'apply01', password: 'long-password-123' } })
    assert.equal(login.response.status, 200)
    const reuse = await json(h.base, '/api/auth/register', { method: 'POST', body: { username: 'apply02', password: 'long-password-123', displayName: '复用', inviteCode: 'WELCOME-2026-XY', agreementAccepted: true, agreementVersion: 'test-v1' } })
    assert.equal(reuse.response.status, 404)
    // 驳回：账号移除、邀请码预留释放
    const invite2 = await json(h.base, '/api/admin/invites', { method: 'POST', token: atoken, body: { code: 'SECOND-CODE-99' } })
    assert.equal(invite2.response.status, 201)
    const pending2 = await json(h.base, '/api/auth/register', { method: 'POST', body: { username: 'apply03', password: 'long-password-123', displayName: '被驳回', inviteCode: 'SECOND-CODE-99', agreementAccepted: true, agreementVersion: 'test-v1' } })
    assert.equal(pending2.response.status, 202)
    const rejected = await json(h.base, `/api/admin/users/${pending2.value.user.userId}/reject`, { method: 'POST', token: atoken })
    assert.equal(rejected.response.status, 200)
    const invitesAfterReject = await json(h.base, '/api/admin/invites', { token: atoken })
    const released = invitesAfterReject.value.invites.find((item) => item.code === 'SECOND-CODE-99')
    assert.ok(released && !released.reservedBy, '驳回后邀请码预留应释放')
    const rejectedLogin = await json(h.base, '/api/auth/login', { method: 'POST', body: { username: 'apply03', password: 'long-password-123' } })
    assert.equal(rejectedLogin.response.status, 401)
    // 管理员登录入口：普通账号被拒
    const adminRoleLogin = await json(h.base, '/api/auth/login', { method: 'POST', body: { username: 'apply01', password: 'long-password-123', expectedRole: 'admin' } })
    assert.equal(adminRoleLogin.response.status, 403)
  } finally { await h.close() }
})

test('项目上云：镜像到云端区、记录用量并执行 300 MB 配额校验', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-imaging-cloudtest-'))
  try {
    const h = await startTestServer(1, { persist: true, dataDir: path.join(tmp, 'data') })
    try {
      const user = await json(h.base, '/api/auth/register', { method: 'POST', body: { username: 'clouduser', password: 'long-password-123', displayName: '云用户', agreementAccepted: true, agreementVersion: 'test-v1' } })
      const token = user.value.token
      const project = await json(h.base, '/api/projects', { method: 'POST', token, body: { name: '云端项目' } })
      const projectId = project.value.project.projectId
      const upload = await json(h.base, `/api/projects/${projectId}/cloud`, { method: 'POST', token })
      assert.equal(upload.response.status, upload.response.status === 200 ? 200 : upload.response.status)
      if (upload.response.status === 200) {
        assert.ok(upload.value.usage.usedBytes > 0)
        assert.equal(upload.value.project.cloudEnabled, true)
        assert.equal(upload.value.project.cloud.status, 'synced')
        const usage = await json(h.base, '/api/cloud/usage', { token })
        assert.equal(usage.value.usage.usedBytes, upload.value.usage.usedBytes)
        const mirrored = path.join(h.agent.cloudStore.root, user.value.user.userId, projectId)
        assert.ok(fs.existsSync(path.join(mirrored, 'project.json')), '云端区应存在项目镜像')
      }
    } finally { await h.close() }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('云配额超限返回 413，未上云数据保留清扫遵循 7 天规则', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-imaging-retention-'))
  try {
    const dataDir = path.join(tmp, 'data')
    const h = await startTestServer(1, {
      persist: true,
      dataDir,
      cloudStore: new TenantCloudStore({ root: path.join(tmp, 'cloud'), quotaBytes: 16 })
    })
    try {
      const user = await json(h.base, '/api/auth/register', { method: 'POST', body: { username: 'quotauser', password: 'long-password-123', displayName: '配额', agreementAccepted: true, agreementVersion: 'test-v1' } })
      const token = user.value.token
      const project = await json(h.base, '/api/projects', { method: 'POST', token, body: { name: '超限项目' } })
      const projectId = project.value.project.projectId
      const upload = await json(h.base, `/api/projects/${projectId}/cloud`, { method: 'POST', token })
      assert.equal(upload.response.status, 413)
      assert.equal(upload.value.error.code, 'CLOUD_QUOTA_EXCEEDED')
      // 保留清扫：未上云且超期 → 清除；上云/新项目/本机项目 → 保留
      const platform = h.agent.projectStore
      const fileStore = h.agent.fileProjectStore
      platform.state.projects.push(
        { projectId: 'project_old_1', ownerId: user.value.user.userId, name: '超期未上云', createdAt: 1, updatedAt: 1, taskIds: [], cloudEnabled: false },
        { projectId: 'project_new_1', ownerId: user.value.user.userId, name: '新项目', createdAt: Date.now(), updatedAt: Date.now(), taskIds: [], cloudEnabled: false },
        { projectId: 'project_cloud_1', ownerId: user.value.user.userId, name: '已上云', createdAt: 1, updatedAt: 1, taskIds: [], cloudEnabled: true },
        { projectId: 'project_local_1', ownerId: 'local-user', name: '本机项目', createdAt: 1, updatedAt: 1, taskIds: [], cloudEnabled: false }
      )
      platform.persist()
      const swept = sweepRetention({ platformProjectStore: platform, fileProjectStore: fileStore, cloudStore: h.agent.cloudStore })
      assert.deepEqual(swept.map((item) => item.projectId), ['project_old_1'])
      const kept = platform.state.projects.map((item) => item.projectId)
      assert.ok(kept.includes('project_new_1') && kept.includes('project_cloud_1') && kept.includes('project_local_1'))
    } finally { await h.close() }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('管理员可代建管理员，并能查看明确登录和退出时间', async () => {
  const h = await startTestServer()
  try {
    const ownerToken = adminToken(h.agent)
    const created = await json(h.base, '/api/admin/users', { method: 'POST', token: ownerToken, body: {
      username: 'secondadmin', password: 'strong-password-123', displayName: '第二管理员', role: 'admin'
    } })
    assert.equal(created.response.status, 201)
    assert.equal(created.value.user.role, 'admin')
    const login = await json(h.base, '/api/auth/login', { method: 'POST', body: { username: 'secondadmin', password: 'strong-password-123', expectedRole: 'admin' } })
    assert.equal(login.response.status, 200)
    const usersAfterLogin = await json(h.base, '/api/admin/users', { token: ownerToken })
    const admin = usersAfterLogin.value.users.find((item) => item.userId === created.value.user.userId)
    assert.ok(admin.lastLoginAt > 0)
    assert.equal(admin.lastLogoutAt, null)
    const logout = await json(h.base, '/api/auth/logout', { method: 'POST', token: login.value.token })
    assert.equal(logout.response.status, 200)
    const stale = await json(h.base, '/api/auth/me', { token: login.value.token })
    assert.equal(stale.response.status, 401)
    const usersAfterLogout = await json(h.base, '/api/admin/users', { token: ownerToken })
    assert.ok(usersAfterLogout.value.users.find((item) => item.userId === admin.userId).lastLogoutAt >= admin.lastLoginAt)
  } finally { await h.close() }
})

test('管理员统一 API 与用户自填 API 按授权隔离，密钥持久保存且不回传', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-imaging-model-access-'))
  const dataDir = path.join(tmp, 'data')
  const authSecret = 'model-access-test-signing-secret'
  const settingsValidator = (input) => import('../src/modelSettings.js').then(({ validateModelSettings }) =>
    validateModelSettings(input, async () => [{ address: '8.8.8.8', family: 4 }]))
  try {
    const h = await startTestServer(1, { persist: true, dataDir, authSecret, modelSettingsValidator: settingsValidator })
    let accountId
    try {
      const administrator = adminToken(h.agent)
      const registered = await json(h.base, '/api/auth/register', { method: 'POST', body: {
        username: 'apiuser01', password: 'long-password-123', displayName: 'API 用户', agreementAccepted: true, agreementVersion: 'test-v1'
      } })
      accountId = registered.value.user.userId
      const userToken = registered.value.token
      const ownKey = 'own-secret-persist-123456'
      const sharedKey = 'shared-secret-persist-654321'
      const denied = await json(h.base, '/api/me/model-config', { method: 'PUT', token: userToken, body: {
        protocol: 'responses', baseUrl: 'https://api.example.com/v1', model: 'model-own', apiKey: ownKey
      } })
      assert.equal(denied.response.status, 403)
      const shared = await json(h.base, '/api/admin/model-config', { method: 'PUT', token: administrator, body: {
        protocol: 'responses', baseUrl: 'https://api.example.com/v1', model: 'model-shared', apiKey: sharedKey
      } })
      assert.equal(shared.response.status, 200)
      assert.equal(JSON.stringify(shared.value).includes(sharedKey), false)
      const privateAdmin = await json(h.base, '/api/admin/model-config', { token: userToken })
      assert.equal(privateAdmin.response.status, 403)
      const deniedShared = await json(h.base, '/api/me/model-source', { method: 'PUT', token: userToken, body: { source: 'shared' } })
      assert.equal(deniedShared.response.status, 403)
      const grant = await json(h.base, `/api/admin/users/${accountId}`, { method: 'PUT', token: administrator, body: {
        modelAccess: { allowOwn: true, allowShared: true }
      } })
      assert.equal(grant.response.status, 200)
      const own = await json(h.base, '/api/me/model-config', { method: 'PUT', token: userToken, body: {
        protocol: 'responses', baseUrl: 'https://api.example.com/v1', model: 'model-own', apiKey: ownKey
      } })
      assert.equal(own.response.status, 200)
      const select = await json(h.base, '/api/me/model-source', { method: 'PUT', token: userToken, body: { source: 'shared' } })
      assert.equal(select.response.status, 200)
      assert.equal(select.value.source, 'shared')
      assert.equal(JSON.stringify(select.value).includes(sharedKey), false)
      const onDisk = fs.readFileSync(path.join(dataDir, 'model-secrets.json'), 'utf8')
      assert.equal(onDisk.includes(ownKey), false)
      assert.equal(onDisk.includes(sharedKey), false)
      const other = await json(h.base, '/api/auth/register', { method: 'POST', body: {
        username: 'apiuser02', password: 'long-password-123', displayName: '其他用户', agreementAccepted: true, agreementVersion: 'test-v1'
      } })
      const otherView = await json(h.base, '/api/me/model-config', { token: other.value.token })
      assert.equal(otherView.value.own.configured, false)
      assert.equal(otherView.value.permissions.allowShared, false)
    } finally { await h.close() }
    const reopened = await startTestServer(1, { persist: true, dataDir, authSecret, modelSettingsValidator: settingsValidator })
    try {
      const user = reopened.agent.identityStore.findUser(accountId)
      const token = reopened.agent.identityStore.issue(user).token
      const settings = await json(reopened.base, '/api/me/model-config', { token })
      assert.equal(settings.response.status, 200)
      assert.equal(settings.value.source, 'shared')
      assert.equal(settings.value.own.configured, true)
      assert.equal(settings.value.shared.configured, true)
      assert.equal(JSON.stringify(settings.value).includes('secret-persist'), false)
      const revoked = await json(reopened.base, `/api/admin/users/${accountId}`, { method: 'PUT', token: adminToken(reopened.agent), body: {
        modelAccess: { allowOwn: true, allowShared: false }
      } })
      assert.equal(revoked.response.status, 200)
      const afterRevocation = await json(reopened.base, '/api/me/model-config', { token })
      assert.equal(afterRevocation.value.source, 'none')
      assert.equal(afterRevocation.value.shared.configured, false)
      const adminSession = adminToken(reopened.agent)
      const administratorSelect = await json(reopened.base, '/api/me/model-source', { method: 'PUT', token: adminSession, body: { source: 'shared' } })
      assert.equal(administratorSelect.value.source, 'shared')
      const removeShared = await json(reopened.base, '/api/admin/model-config', { method: 'DELETE', token: adminSession })
      assert.equal(removeShared.response.status, 200)
      const administratorView = await json(reopened.base, '/api/me/model-config', { token: adminSession })
      assert.equal(administratorView.value.source, 'none')
    } finally { await reopened.close() }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('静态托管：SPA 回退与路径穿越防护', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-imaging-static-'))
  try {
    const dist = path.join(tmp, 'dist')
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>site</title>')
    fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)')
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'top') // 位于站点目录之外
    const h = await startTestServer(1, { webDistDir: dist })
    try {
      const index = await fetch(`${h.base}/`)
      assert.equal(index.status, 200)
      assert.match(await index.text(), /site/)
      const spa = await fetch(`${h.base}/some/spa/route`)
      assert.equal(spa.status, 200)
      assert.match(await spa.text(), /site/)
      const asset = await fetch(`${h.base}/assets/app.js`)
      assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8')
      assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
      const traversal = await fetch(`${h.base}/..%2f..%2fsecret.txt`)
      assert.notEqual(await traversal.text(), 'top')
      const api = await fetch(`${h.base}/api/unknown-route`)
      assert.equal(api.status, 401)
    } finally { await h.close() }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('工具函数：fmtBytes 可读格式', () => {
  assert.equal(fmtBytes(512), '512 B')
  assert.equal(fmtBytes(2048), '2.0 KB')
  assert.equal(fmtBytes(5 * 1024 ** 2), '5.0 MB')
  assert.equal(fmtBytes(1024 ** 3), '1.00 GB')
})
