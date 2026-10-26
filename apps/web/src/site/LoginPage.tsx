// 登录页：用户登录 / 管理员登录 / 注册三合一；注册需账户名查重、协议确认。
// 桌面端与插件（宿主桥接模式）不提供注册界面，引导前往网页端注册。
import { useEffect, useRef, useState } from 'react'
import { Particles } from './Particles'
import { AGREEMENT_VERSION, AgreementDocument } from './AgreementDocument'
import { BrandMark, COPYRIGHT, GONGWANG_NUMBER, GONGWANG_URL, ICP_NUMBER, ICP_URL } from './Chrome'
import { navigate } from './router'
import { saveSession, siteApi, type SiteSession, type SiteUser } from './session'
import { getHostBridge } from '../host/bridge'

type Tab = 'user' | 'admin' | 'register'

interface AuthResult {
  user?: SiteUser
  token?: string
  pendingApproval?: boolean
}

function useAuthBase(): { base: string; embedded: boolean } {
  const embedded = !!getHostBridge()
  const [base, setBase] = useState(embedded ? '' : window.location.origin)
  useEffect(() => {
    if (!embedded) return
    let active = true
    void getHostBridge()?.getAgentConfig().then((config) => {
      if (active) setBase(config.baseUrl ?? '')
    }).catch(() => { if (active) setBase('') })
    return () => { active = false }
  }, [embedded])
  return { base, embedded }
}

function AgreementModal({ onAgree, onClose }: { onAgree: () => void; onClose: () => void }) {
  return (
    <div className="sd-modal-mask" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sd-modal" role="dialog" aria-modal="true" aria-label="用户协议与隐私政策">
        <div className="sd-modal__head">
          <h3>用户协议与隐私政策</h3>
          <button className="sd-modal__close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="sd-modal__body">
          <AgreementDocument />
        </div>
        <div className="sd-modal__foot">
          <button className="sd-btn sd-btn--ghost sd-btn--sm" onClick={onClose}>不同意</button>
          <button className="sd-btn sd-btn--primary sd-btn--sm" onClick={onAgree}>同意并继续</button>
        </div>
      </div>
    </div>
  )
}

export function LoginPage() {
  const initialTab = (new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('mode') === 'register' ? 'register' : 'user') as Tab
  const [tab, setTab] = useState<Tab>(initialTab)
  const { base, embedded } = useAuthBase()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [phone, setPhone] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [showAgreement, setShowAgreement] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)
  const [availability, setAvailability] = useState<{ state: 'idle' | 'checking' | 'ok' | 'bad'; reason?: string }>({ state: 'idle' })
  const availabilityTimer = useRef<number | null>(null)

  // 已登录用户访问登录页：直接进入工作台
  useEffect(() => {
    try {
      const raw = localStorage.getItem('spark-sight.session.v1')
      if (raw) navigate('/app', { replace: true })
    } catch { /* ignore */ }
  }, [])

  // 桌面端 / 插件不提供注册：若通过 URL 参数等进入 register，立即回退到用户登录。
  useEffect(() => {
    if (embedded && tab === 'register') setTab('user')
  }, [embedded, tab])

  useEffect(() => {
    if (tab !== 'register') return
    const value = username.trim()
    if (!value) { setAvailability({ state: 'idle' }); return }
    if (value.length < 6) { setAvailability({ state: 'bad', reason: '账户名不得少于 6 位' }); return }
    if (/[\u4e00-\u9fff]/.test(value)) { setAvailability({ state: 'bad', reason: '账户名不得包含中文' }); return }
    setAvailability({ state: 'checking' })
    if (availabilityTimer.current) window.clearTimeout(availabilityTimer.current)
    availabilityTimer.current = window.setTimeout(async () => {
      try {
        const result = await siteApi<{ available: boolean; reason?: string }>(base, `/api/auth/username-available?username=${encodeURIComponent(value)}`)
        setAvailability(result.available ? { state: 'ok' } : { state: 'bad', reason: result.reason ?? '该账户名不可用' })
      } catch (e) {
        setAvailability({ state: 'bad', reason: e instanceof Error ? e.message : '查重服务暂不可用' })
      }
    }, 320)
    return () => { if (availabilityTimer.current) window.clearTimeout(availabilityTimer.current) }
  }, [username, tab, base])

  const finishLogin = (result: AuthResult) => {
    if (!result.token || !result.user) {
      setSuccess('')
      setError('登录响应缺少会话令牌，请稍后重试')
      return
    }
    const session: SiteSession = { token: result.token, baseUrl: base, user: result.user, loginAt: Date.now() }
    saveSession(session)
    navigate(!getHostBridge() && result.user.role === 'admin' ? '/admin' : '/app')
  }

  const submit = async () => {
    if (busy) return
    setError('')
    setSuccess('')
    if (!base) { setError('本机 Agent 尚未就绪，请稍后重试或重启客户端'); return }
    if (!agreed) {
      setError('请先阅读并同意《用户协议与隐私政策》')
      return
    }
    if (tab === 'register') {
      if (!username.trim() || !password || !displayName.trim() || !phone.trim()) {
        setError('请完整填写账户名、密码、姓名与手机号')
        return
      }
      if (password.length < 10) { setError('密码至少 10 个字符'); return }
      if (password !== confirm) { setError('两次输入的密码不一致'); return }
      if (!/^1[3-9]\d{9}$/.test(phone.trim())) { setError('请输入正确的 11 位手机号'); return }
      setBusy(true)
      try {
        const result = await siteApi<AuthResult>(base, '/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ username: username.trim(), password, displayName: displayName.trim(), phone: phone.trim(), inviteCode: inviteCode.trim() || undefined, agreementAccepted: true, agreementVersion: AGREEMENT_VERSION })
        })
        if (result.pendingApproval) {
          setSuccess('注册申请已提交，请等待管理员审核通过后登录。')
          setTab('user')
        } else {
          finishLogin(result)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '注册失败，请稍后重试')
      } finally { setBusy(false) }
      return
    }
    if (!username.trim() || !password) { setError('请输入账户名与密码'); return }
    setBusy(true)
    try {
      const result = await siteApi<AuthResult>(base, '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: username.trim(), password, ...(tab === 'admin' ? { expectedRole: 'admin' } : {}) })
      })
      finishLogin(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败，请稍后重试')
    } finally { setBusy(false) }
  }

  const needAgreement = !agreed
  return (
    <div className="sd-root sd-auth">
      <Particles />
      <div className="sd-auth__glow" />
      <div style={{ position: 'relative', zIndex: 1, padding: '18px 24px' }}>
        <BrandMark />
      </div>
      <div className="sd-auth__body">
        <div className="sd-auth__card">
          <h1 className="sd-auth__title">{tab === 'register' ? '创建您的账户' : tab === 'admin' ? '管理员登录' : '欢迎回来'}</h1>
          <p className="sd-auth__subtitle">
            {tab === 'register' ? '注册即享三方案智能绘图与 300 MB 云端项目空间' : tab === 'admin' ? '登录管理控制台，管理用户与邀请码' : '登录灵感视界，继续您的科研绘图'}
          </p>

          <div className="sd-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'user'} className={tab === 'user' ? 'active' : ''} onClick={() => { setTab('user'); setError(''); setSuccess('') }}>用户登录</button>
            <button role="tab" aria-selected={tab === 'admin'} className={tab === 'admin' ? 'active' : ''} onClick={() => { setTab('admin'); setError(''); setSuccess('') }}>管理员登录</button>
            {!embedded && (
              <button role="tab" aria-selected={tab === 'register'} className={tab === 'register' ? 'active' : ''} onClick={() => { setTab('register'); setError(''); setSuccess('') }}>注册</button>
            )}
          </div>

          <form className="sd-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
            {!embedded && tab === 'register' && (
              <>
                <div className="sd-field">
                  <label htmlFor="reg-username">账户名</label>
                  <input
                    id="reg-username"
                    className={`sd-input ${availability.state === 'bad' ? 'sd-input--error' : ''}`}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="6 位以上，仅字母、数字、点、下划线或连字符"
                    autoComplete="username"
                  />
                  <span className={`sd-hint ${availability.state === 'ok' ? 'sd-hint--ok' : availability.state === 'bad' ? 'sd-hint--error' : ''}`}>
                    {availability.state === 'checking' ? '正在检查账户名可用性…'
                      : availability.state === 'ok' ? '该账户名可用'
                      : availability.state === 'bad' ? availability.reason
                      : '注册后不可修改'}
                  </span>
                </div>
                <div className="sd-form__row">
                  <div className="sd-field">
                    <label htmlFor="reg-password">密码</label>
                    <input id="reg-password" type="password" className="sd-input" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 10 个字符" autoComplete="new-password" />
                  </div>
                  <div className="sd-field">
                    <label htmlFor="reg-confirm">确认密码</label>
                    <input id="reg-confirm" type="password" className={`sd-input ${confirm && confirm !== password ? 'sd-input--error' : ''}`} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="再次输入密码" autoComplete="new-password" />
                  </div>
                </div>
                <div className="sd-form__row">
                  <div className="sd-field">
                    <label htmlFor="reg-name">姓名</label>
                    <input id="reg-name" className="sd-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="您的真实姓名" />
                  </div>
                  <div className="sd-field">
                    <label htmlFor="reg-phone">手机号</label>
                    <input id="reg-phone" className="sd-input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="11 位手机号" inputMode="numeric" />
                  </div>
                </div>
                <div className="sd-field">
                  <label htmlFor="reg-invite">邀请码（选填）</label>
                  <input id="reg-invite" className="sd-input" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="如收到邀请码请在此填写，每个邀请码仅可使用一次" />
                </div>
              </>
            )}
            {tab === 'register' && <label className="sd-auth__agreement"><input type="checkbox" checked disabled /> 默认使用自己填写的模型 API；统一模型暂不开放</label>}
            {tab !== 'register' && (
              <>
                <div className="sd-field">
                  <label htmlFor="login-username">账户名</label>
                  <input id="login-username" className="sd-input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="请输入账户名" autoComplete="username" />
                </div>
                <div className="sd-field">
                  <label htmlFor="login-password">密码</label>
                  <input id="login-password" type="password" className="sd-input" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="请输入密码" autoComplete="current-password" />
                </div>
              </>
            )}

            {error && <div className="sd-form__error" role="alert">{error}</div>}
            {success && <div className="sd-form__success" role="status">{success}</div>}

            <label className="sd-agree">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => {
                  if (e.target.checked) setShowAgreement(true)
                  else setAgreed(false)
                }}
              />
              <span>
                我已阅读并同意
                <a href="#/agreement" onClick={(e) => { e.preventDefault(); setShowAgreement(true) }}>《用户协议与隐私政策》</a>
              </span>
            </label>

            <button className="sd-btn sd-btn--primary" type="submit" disabled={busy || needAgreement || (tab === 'register' && availability.state === 'bad')}>
              {busy ? '处理中…' : tab === 'register' ? '同意并注册' : tab === 'admin' ? '管理员登录' : '登 录'}
            </button>
          </form>

          {embedded && (
            <div className="sd-auth__embed">
              桌面端 / 插件暂不支持注册。请前往
              <a className="sd-link" href="#/" onClick={(e) => { e.preventDefault(); navigate('/') }}> 官网 </a>
              或网页端完成注册后，再使用同一账号登录。账号与明确保存的绘图偏好四端通用，本地项目、数据和聊天不会自动上传。
            </div>
          )}
          {!embedded && tab !== 'register' && (
            <div className="sd-auth__alt">
              还没有账户？
              <a href="#/login?mode=register" onClick={(e) => { e.preventDefault(); setTab('register') }}>立即注册</a>
            </div>
          )}
        </div>
      </div>
      <footer className="sd-footer" style={{ padding: '18px 0' }}>
        <div className="sd-container sd-footer__beian" style={{ margin: '0 auto', borderTop: 'none', paddingTop: 0, marginTop: 0, justifyContent: 'center' }}>
          <a className="sd-footer__beain-link" href={ICP_URL} target="_blank" rel="noopener noreferrer">{ICP_NUMBER}</a>
          <a className="sd-footer__beain-link" href={GONGWANG_URL} target="_blank" rel="noopener noreferrer">
            <img src="/beian-gongan.png" alt="公安备案图标" />
            <span>{GONGWANG_NUMBER}</span>
          </a>
          <span className="sd-footer__copy" style={{ margin: 0 }}>{COPYRIGHT}</span>
        </div>
      </footer>
      {showAgreement && (
        <AgreementModal
          onClose={() => { setShowAgreement(false); setAgreed(false) }}
          onAgree={() => { setAgreed(true); setShowAgreement(false) }}
        />
      )}
    </div>
  )
}
