// 管理控制台：用户管理（待审核通过/驳回、资料与密码修改、删除）与邀请码管理。
// 仅管理员角色可进入（main.tsx 门控 + 后端双重校验）。
import { useCallback, useEffect, useState } from 'react'
import { Particles } from './Particles'
import { BrandMark, COPYRIGHT, GONGWANG_NUMBER, GONGWANG_URL, ICP_NUMBER, ICP_URL } from './Chrome'
import { navigate } from './router'
import { loadSession, logoutSession, siteApi, type SiteSession, type SiteUser } from './session'
import { endpointForProtocol, type ModelSettings } from '../client/modelSettings'

interface AdminUser extends SiteUser {
  createdAt: number | null
  approvedAt: number | null
  lastLoginAt: number | null
  lastLogoutAt: number | null
  modelAccess: { allowOwn: boolean; allowShared: boolean }
}

interface ModelSummary {
  configured: boolean
  protocol?: 'responses' | 'chat_completions' | 'anthropic_messages'
  baseUrl?: string
  model?: string
}

interface Invite {
  code: string
  createdAt: number
  createdBy: string | null
  reservedBy: string | null
  reservedAt: number | null
}

interface CloudUsage {
  usedBytes: number
  quotaBytes: number
  usedText?: string
  quotaText?: string
}

const fmtTime = (value: number | null | undefined) => {
  if (!value) return '—'
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function StatusPill({ user }: { user: AdminUser }) {
  if (user.role === 'admin') return <span className="sd-pill sd-pill--admin">管理员</span>
  if (user.status === 'pending') return <span className="sd-pill sd-pill--pending">待审核</span>
  if (user.disabled) return <span className="sd-pill sd-pill--disabled">已停用</span>
  return <span className="sd-pill sd-pill--active">正常</span>
}

export function AdminPage() {
  const [session, setSession] = useState<SiteSession | null>(() => loadSession())
  const [tab, setTab] = useState<'users' | 'invites' | 'api'>('users')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [usage, setUsage] = useState<CloudUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [inviteInput, setInviteInput] = useState('')
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [editName, setEditName] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [editPassword, setEditPassword] = useState('')
  const [editAccess, setEditAccess] = useState({ allowOwn: false, allowShared: false })
  const [creating, setCreating] = useState(false)
  const [newUser, setNewUser] = useState({ username: '', password: '', displayName: '', phone: '', role: 'user', allowOwn: false, allowShared: false })
  const [sharedModel, setSharedModel] = useState<ModelSummary>({ configured: false })
  const [sharedForm, setSharedForm] = useState({ protocol: 'responses', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', model: 'ark-code-latest', apiKey: '' })

  const requireSession = useCallback((): SiteSession | null => {
    const current = loadSession()
    if (!current) {
      navigate('/login', { replace: true })
      return null
    }
    return current
  }, [])

  const refresh = useCallback(async () => {
    const current = requireSession()
    if (!current) return
    setLoading(true)
    setError('')
    try {
      const [userList, inviteList, usageInfo, modelInfo] = await Promise.all([
        siteApi<{ users: AdminUser[] }>(current.baseUrl, '/api/admin/users', { token: current.token }),
        siteApi<{ invites: Invite[] }>(current.baseUrl, '/api/admin/invites', { token: current.token }),
        siteApi<{ usage: CloudUsage }>(current.baseUrl, '/api/cloud/usage', { token: current.token }).catch(() => ({ usage: null })),
        siteApi<ModelSummary>(current.baseUrl, '/api/admin/model-config', { token: current.token })
      ])
      setUsers(userList.users ?? [])
      setInvites(inviteList.invites ?? [])
      setUsage(usageInfo.usage)
      setSharedModel(modelInfo)
      setSharedForm((currentForm) => ({ ...currentForm, protocol: modelInfo.protocol ?? currentForm.protocol, baseUrl: modelInfo.baseUrl ?? currentForm.baseUrl, model: modelInfo.model ?? currentForm.model }))
    } catch (e) {
      if ((e as { status?: number }).status === 403) {
        setError('当前账号没有管理员权限')
      } else {
        setError(e instanceof Error ? e.message : '加载管理数据失败')
      }
    } finally { setLoading(false) }
  }, [requireSession])

  useEffect(() => { void refresh() }, [refresh])

  const act = async (action: () => Promise<unknown>, okMessage: string) => {
    const current = requireSession()
    if (!current) return
    setError('')
    setNotice('')
    try {
      await action()
      setNotice(okMessage)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    }
  }

  const logout = async () => {
    try { await logoutSession() } catch { /* 网络错误也允许退出本机界面 */ }
    navigate('/login', { replace: true })
  }

  const usagePercent = usage && usage.quotaBytes > 0 ? Math.min(100, Math.round((usage.usedBytes / usage.quotaBytes) * 100)) : 0

  return (
    <div className="sd-root sd-admin">
      <Particles />
      <div className="sd-shell">
        <div className="sd-admin__top">
          <div className="sd-container sd-container--wide sd-admin__top-inner">
            <BrandMark />
            <span style={{ color: 'var(--sd-text-faint)', fontSize: 13 }}>管理控制台</span>
            <div className="sd-admin__user">
              <span className="sd-admin__avatar">{session?.user.displayName?.slice(0, 1) ?? 'A'}</span>
              <span>{session?.user.displayName ?? '管理员'}</span>
              <button className="sd-btn sd-btn--ghost sd-btn--sm" onClick={() => navigate('/app')}>进入工作台</button>
              <button className="sd-btn sd-btn--ghost sd-btn--sm" onClick={() => void logout()}>退出登录</button>
            </div>
          </div>
        </div>

        <main className="sd-admin__main sd-container sd-container--wide">
          <div className="sd-admin__head">
            <div>
              <h1>管理控制台</h1>
              <p>管理账号、模型 API 授权与邀请码；登录和退出时间以服务器记录为准。</p>
            </div>
            <div className="sd-admin__usage">
              {usage && (
                <div className="sd-meter" title="全部用户已用云存储 / 总配额">
                  <div className="sd-meter__bar"><div className="sd-meter__fill" style={{ width: `${usagePercent}%` }} /></div>
                  <div className="sd-meter__label"><span>云存储 {usage.usedText ?? `${usage.usedBytes} B`}</span><span>{usagePercent}%</span></div>
                </div>
              )}
            </div>
          </div>

          <div className="sd-admin__tabs">
            <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>用户管理</button>
            <button className={tab === 'invites' ? 'active' : ''} onClick={() => setTab('invites')}>邀请码管理</button>
            <button className={tab === 'api' ? 'active' : ''} onClick={() => setTab('api')}>统一 API 配置</button>
          </div>

          {error && <div className="sd-form__error" role="alert" style={{ marginBottom: 14 }}>{error}</div>}
          {notice && <div className="sd-form__success" role="status" style={{ marginBottom: 14 }}>{notice}</div>}

          {tab === 'users' && (
            <>
              <div className="sd-admin__head" style={{ marginBottom: 14 }}>
                <p style={{ margin: 0 }}>共 {users.length} 个账号；待审核注册显示「通过 / 不通过」操作。</p>
                <button className="sd-btn sd-btn--primary sd-btn--sm" onClick={() => { setCreating(true); setNewUser({ username: '', password: '', displayName: '', phone: '', role: 'user', allowOwn: false, allowShared: false }) }}>添加账号</button>
              </div>
              <div className="sd-table-wrap">
                {loading ? (
                  <div className="sd-admin__empty">正在加载用户…</div>
                ) : users.length === 0 ? (
                  <div className="sd-admin__empty">暂无用户</div>
                ) : (
                  <table className="sd-table">
                    <thead>
                      <tr>
                        <th>账户名</th><th>姓名</th><th>状态</th><th>注册时间</th><th>最近登录</th><th>最近明确退出</th><th>模型授权</th><th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((user) => (
                        <tr key={user.userId}>
                          <td className="strong">{user.username}</td>
                          <td>{user.displayName}</td>
                          <td><StatusPill user={user} /></td>
                          <td>{fmtTime(user.createdAt)}</td>
                          <td>{fmtTime(user.lastLoginAt)}</td>
                          <td title="仅记录用户点击退出；关闭浏览器不视为退出">{fmtTime(user.lastLogoutAt)}</td>
                          <td>{user.role === 'admin' ? '全部管理权限' : [user.modelAccess?.allowOwn ? '自填' : '', user.modelAccess?.allowShared ? '统一' : ''].filter(Boolean).join(' / ') || '未授权'}</td>
                          <td>
                            <div className="sd-actions">
                              {user.status === 'pending' ? (
                                <>
                                  <button className="sd-btn sd-btn--primary sd-btn--sm" onClick={() => void act(() => siteApi(`${session!.baseUrl}`, `/api/admin/users/${user.userId}/approve`, { method: 'POST', token: session!.token }), `已通过 ${user.username} 的注册申请`)}>通过</button>
                                  <button className="sd-btn sd-btn--danger sd-btn--sm" onClick={() => void act(() => siteApi(`${session!.baseUrl}`, `/api/admin/users/${user.userId}/reject`, { method: 'POST', token: session!.token }), `已驳回 ${user.username} 的注册申请`)}>不通过</button>
                                </>
                              ) : (
                                <>
                                  <button className="sd-btn sd-btn--ghost sd-btn--sm" onClick={() => { setEditing(user); setEditName(user.displayName); setEditPhone(user.phone ?? ''); setEditPassword(''); setEditAccess(user.modelAccess ?? { allowOwn: false, allowShared: false }) }}>编辑</button>
                                  {user.role !== 'admin' && (
                                    <button className="sd-btn sd-btn--danger sd-btn--sm" onClick={() => { if (window.confirm(`确定删除用户 ${user.username} 吗？该用户名下项目与云端数据将一并清除。`)) void act(() => siteApi(`${session!.baseUrl}`, `/api/admin/users/${user.userId}`, { method: 'DELETE', token: session!.token }), `已删除用户 ${user.username}`) }}>删除</button>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}

          {tab === 'api' && (
            <section className="sd-admin__model" aria-label="统一模型 API 配置">
              <h2>管理员统一 API</h2>
              <p>配置保存在服务器，用户只有获得「使用统一 API」授权后才能选择使用。API Key 不回传浏览器；留空可保留已保存的密钥。</p>
              <p>{sharedModel.configured ? `已配置：${sharedModel.model} · ${sharedModel.protocol}` : '尚未配置统一 API'}</p>
              <form className="sd-form" onSubmit={(event) => {
                event.preventDefault()
                void act(async () => {
                  await siteApi(session!.baseUrl, '/api/admin/model-config', {
                    method: 'PUT', token: session!.token, body: JSON.stringify(sharedForm)
                  })
                  setSharedForm((value) => ({ ...value, apiKey: '' }))
                }, '统一 API 已保存，授权用户下次任务即可使用')
              }}>
                <div className="sd-field">
                  <label htmlFor="admin-api-protocol">接口类型</label>
                  <select id="admin-api-protocol" className="sd-input" value={sharedForm.protocol} onChange={(event) => {
                    const protocol = event.target.value as ModelSettings['protocol']
                    setSharedForm({ ...sharedForm, protocol, baseUrl: endpointForProtocol(protocol, sharedForm.baseUrl) })
                  }}>
                    <option value="responses">OpenAI Responses</option>
                    <option value="chat_completions">OpenAI Chat Completions</option>
                    <option value="anthropic_messages">Anthropic Messages</option>
                  </select>
                </div>
                <div className="sd-field"><label htmlFor="admin-api-url">HTTPS API 地址</label><input id="admin-api-url" className="sd-input" value={sharedForm.baseUrl} onChange={(event) => setSharedForm({ ...sharedForm, baseUrl: event.target.value })} /></div>
                <div className="sd-field"><label htmlFor="admin-api-model">模型名称</label><input id="admin-api-model" className="sd-input" value={sharedForm.model} onChange={(event) => setSharedForm({ ...sharedForm, model: event.target.value })} /></div>
                <div className="sd-field"><label htmlFor="admin-api-key">API Key</label><input id="admin-api-key" className="sd-input" type="password" autoComplete="off" value={sharedForm.apiKey} placeholder={sharedModel.configured ? '已保存；留空保持现有密钥' : '填写 API Key'} onChange={(event) => setSharedForm({ ...sharedForm, apiKey: event.target.value })} /></div>
                <div className="sd-actions">
                  <button className="sd-btn sd-btn--primary sd-btn--sm" type="submit">保存统一 API</button>
                  <button className="sd-btn sd-btn--danger sd-btn--sm" type="button" disabled={!sharedModel.configured} onClick={() => {
                    if (window.confirm('清除服务器统一 API 配置？已授权用户将无法继续使用这套密钥。')) void act(() => siteApi(session!.baseUrl, '/api/admin/model-config', { method: 'DELETE', token: session!.token }), '统一 API 已清除')
                  }}>清除统一 API</button>
                </div>
              </form>
            </section>
          )}

          {tab === 'invites' && (
            <>
              <div className="sd-toolbar" style={{ marginBottom: 14 }}>
                <input
                  className="sd-input"
                  style={{ maxWidth: 360 }}
                  value={inviteInput}
                  onChange={(e) => setInviteInput(e.target.value)}
                  placeholder="填写 10 位以上邀请码（字母/数字/下划线/连字符）"
                />
                <button
                  className="sd-btn sd-btn--primary sd-btn--sm"
                  disabled={inviteInput.trim().length > 0 && inviteInput.trim().length < 10}
                  onClick={() => void act(async () => { await siteApi(`${session!.baseUrl}`, '/api/admin/invites', { method: 'POST', token: session!.token, body: JSON.stringify({ code: inviteInput.trim() || undefined }) }); setInviteInput('') }, '邀请码已创建')}
                >创建邀请码</button>
                <button
                  className="sd-btn sd-btn--ghost sd-btn--sm"
                  onClick={() => void act(async () => { await siteApi(`${session!.baseUrl}`, '/api/admin/invites', { method: 'POST', token: session!.token, body: JSON.stringify({}) }) }, '已随机生成邀请码')}
                >随机生成</button>
                <span style={{ color: 'var(--sd-text-faint)', fontSize: 12.5 }}>邀请码仅可使用一次：注册时预留，审核通过即核销自动删除；驳回则释放。</span>
              </div>
              <div className="sd-table-wrap">
                {loading ? (
                  <div className="sd-admin__empty">正在加载邀请码…</div>
                ) : invites.length === 0 ? (
                  <div className="sd-admin__empty">暂无可用邀请码，点击上方按钮创建</div>
                ) : (
                  <table className="sd-table">
                    <thead>
                      <tr><th>邀请码</th><th>状态</th><th>创建时间</th><th>操作</th></tr>
                    </thead>
                    <tbody>
                      {invites.map((invite) => (
                        <tr key={invite.code}>
                          <td><span className="sd-code">{invite.code}</span></td>
                          <td>
                            {invite.reservedBy
                              ? <span className="sd-pill sd-pill--pending">已被注册预留</span>
                              : <span className="sd-pill sd-pill--active">可用</span>}
                          </td>
                          <td>{fmtTime(invite.createdAt)}</td>
                          <td>
                            <div className="sd-actions">
                              <button className="sd-btn sd-btn--ghost sd-btn--sm" onClick={() => void navigator.clipboard?.writeText(invite.code)}>复制</button>
                              <button className="sd-btn sd-btn--danger sd-btn--sm" onClick={() => void act(() => siteApi(`${session!.baseUrl}`, `/api/admin/invites/${encodeURIComponent(invite.code)}`, { method: 'DELETE', token: session!.token }), '邀请码已删除')}>删除</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </main>

        <footer className="sd-footer" style={{ padding: '18px 0' }}>
          <div className="sd-container sd-footer__beian" style={{ margin: '0 auto', borderTop: 'none', paddingTop: 0, justifyContent: 'center' }}>
            <a className="sd-footer__beain-link" href={ICP_URL} target="_blank" rel="noopener noreferrer">{ICP_NUMBER}</a>
            <a className="sd-footer__beain-link" href={GONGWANG_URL} target="_blank" rel="noopener noreferrer">
              <img src="/beian-gongan.png" alt="公安备案图标" />
              <span>{GONGWANG_NUMBER}</span>
            </a>
            <span className="sd-footer__copy" style={{ margin: 0 }}>{COPYRIGHT}</span>
          </div>
        </footer>
      </div>

      {/* 编辑用户弹窗 */}
      {editing && (
        <div className="sd-modal-mask" onClick={(e) => { if (e.target === e.currentTarget) setEditing(null) }}>
          <div className="sd-modal" style={{ width: 480 }} role="dialog" aria-modal="true" aria-label="编辑用户">
            <div className="sd-modal__head">
              <h3>编辑用户 · {editing.username}</h3>
              <button className="sd-modal__close" onClick={() => setEditing(null)} aria-label="关闭">✕</button>
            </div>
            <div className="sd-modal__body">
              <form className="sd-form" onSubmit={(e) => {
                e.preventDefault()
                void act(async () => {
                  await siteApi(`${session!.baseUrl}`, `/api/admin/users/${editing.userId}`, {
                    method: 'PUT',
                    token: session!.token,
                    body: JSON.stringify({
                      displayName: editName,
                      phone: editPhone,
                      ...(editPassword ? { password: editPassword } : {}),
                      ...(editing.role === 'admin' ? {} : { modelAccess: editAccess })
                    })
                  })
                  if (editPassword) setEditing(null)
                }, editPassword ? '资料与密码已更新，该用户旧会话已全部失效' : '资料已更新')
              }}>
                <div className="sd-field">
                  <label>姓名</label>
                  <input className="sd-input" value={editName} onChange={(e) => setEditName(e.target.value)} />
                </div>
                <div className="sd-field">
                  <label>手机号</label>
                  <input className="sd-input" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} />
                </div>
                <div className="sd-field">
                  <label>重置密码（留空表示不修改）</label>
                  <input className="sd-input" type="password" autoComplete="new-password" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} placeholder="至少 10 个字符；重置后旧会话失效" />
                </div>
                {editing.role !== 'admin' && <div className="sd-admin__permission-options">
                  <label><input type="checkbox" checked={editAccess.allowOwn} onChange={(event) => setEditAccess({ ...editAccess, allowOwn: event.target.checked })} /> 允许用户填写并长期保存自己的 API</label>
                  <label><input type="checkbox" checked={editAccess.allowShared} onChange={(event) => setEditAccess({ ...editAccess, allowShared: event.target.checked })} /> 允许使用管理员统一配置的 API</label>
                </div>}
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button type="button" className="sd-btn sd-btn--ghost sd-btn--sm" onClick={() => setEditing(null)}>取消</button>
                  <button type="submit" className="sd-btn sd-btn--primary sd-btn--sm">保存修改</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* 添加用户弹窗 */}
      {creating && (
        <div className="sd-modal-mask" onClick={(e) => { if (e.target === e.currentTarget) setCreating(false) }}>
          <div className="sd-modal" style={{ width: 480 }} role="dialog" aria-modal="true" aria-label="添加用户">
            <div className="sd-modal__head">
              <h3>添加用户</h3>
              <button className="sd-modal__close" onClick={() => setCreating(false)} aria-label="关闭">✕</button>
            </div>
            <div className="sd-modal__body">
              <form className="sd-form" onSubmit={(e) => {
                e.preventDefault()
                void act(async () => {
                  await siteApi(`${session!.baseUrl}`, '/api/admin/users', {
                    method: 'POST',
                    token: session!.token,
                    body: JSON.stringify({ ...newUser, modelAccess: { allowOwn: newUser.allowOwn, allowShared: newUser.allowShared } })
                  })
                  setCreating(false)
                }, '用户已创建并激活')
              }}>
                <div className="sd-field">
                  <label>账户名</label>
                  <input className="sd-input" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} placeholder="6 位以上，不含中文" />
                </div>
                <div className="sd-field">
                  <label>初始密码</label>
                  <input className="sd-input" type="password" autoComplete="new-password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} placeholder="至少 10 个字符" />
                </div>
                <div className="sd-field"><label htmlFor="new-account-role">账号角色</label><select id="new-account-role" className="sd-input" value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value })}><option value="user">普通用户</option><option value="admin">管理员</option></select></div>
                {newUser.role === 'user' && <div className="sd-admin__permission-options">
                  <label><input type="checkbox" checked={newUser.allowOwn} onChange={(event) => setNewUser({ ...newUser, allowOwn: event.target.checked })} /> 允许自填 API</label>
                  <label><input type="checkbox" checked={newUser.allowShared} onChange={(event) => setNewUser({ ...newUser, allowShared: event.target.checked })} /> 允许使用统一 API</label>
                </div>}
                <div className="sd-form__row">
                  <div className="sd-field">
                    <label>姓名</label>
                    <input className="sd-input" value={newUser.displayName} onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })} />
                  </div>
                  <div className="sd-field">
                    <label>手机号</label>
                    <input className="sd-input" value={newUser.phone} onChange={(e) => setNewUser({ ...newUser, phone: e.target.value })} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button type="button" className="sd-btn sd-btn--ghost sd-btn--sm" onClick={() => setCreating(false)}>取消</button>
                  <button type="submit" className="sd-btn sd-btn--primary sd-btn--sm">创建</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
