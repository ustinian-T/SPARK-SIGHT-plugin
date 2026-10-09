import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { StoreProvider } from './state/store'
import { App } from './App'
import { LandingPage } from './site/LandingPage'
import { LoginPage } from './site/LoginPage'
import { AgreementPage } from './site/AgreementPage'
import { AdminPage } from './site/AdminPage'
import { Particles } from './site/Particles'
import { navigate, useHashRoute } from './site/router'
import { clearSession, loadSession, saveSession, restoreHostSession, SESSION_CHANGED_EVENT, verifySession, type SiteSession } from './site/session'
import { getHostBridge } from './host/bridge'
import './styles/tokens.css'
import './styles/app.css'
import './styles/gate.css'
import './site/site.css'

// 仅显式测试构建可以直通工作台；生产站点的 URL 参数不得跳过登录。
const isDemo = () => import.meta.env.VITE_TEST_WEB === '1'

function Splash({ text = '正在进入灵感视界…' }: { text?: string }) {
  return (
    <div className="sd-root" style={{ display: 'grid', placeItems: 'center' }}>
      <Particles />
      <div style={{ position: 'relative', zIndex: 1, textAlign: 'center' }}>
        <img src="/logo-dark.png" alt="" width={56} height={56} style={{ borderRadius: 14 }} />
        <p style={{ color: 'var(--sd-text-dim, #9db4a8)', marginTop: 14, fontFamily: 'inherit' }}>{text}</p>
      </div>
    </div>
  )
}

function Workspace() {
  return (
    <StoreProvider>
      <App />
    </StoreProvider>
  )
}

function Root() {
  const route = useHashRoute()
  const [session, setSession] = useState<SiteSession | null>(() => loadSession())
  const [checking, setChecking] = useState<boolean>(() => !!getHostBridge() || !!loadSession())

  // 官网 / 登录 / 协议 / 管理台使用正常文档流与滚轮滚动：解除 tokens.css 为全屏工作台
  // 设置的 html/body/#root 高度锁定与 body overflow:hidden；仅工作台（app）保持全屏锁定。
  useEffect(() => {
    const siteMode = route.name !== 'app'
    document.documentElement.classList.toggle('sd-site', siteMode)
    return () => document.documentElement.classList.remove('sd-site')
  }, [route.name])

  // 启动时校验本地会话有效性（过期/被管理员重置密码/被删除 → 回登录页）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const stored = getHostBridge() ? await restoreHostSession() : loadSession()
      if (cancelled) return
      if (!stored) { clearSession(); setSession(null); setChecking(false); return }
      const user = await verifySession(stored)
      if (cancelled) return
      if (!user) {
        clearSession()
        setSession(null)
      } else {
        const next = { ...stored, user: { ...stored.user, ...user } }
        saveSession(next)
        setSession(next)
      }
      setChecking(false)
    })().catch(() => { if (!cancelled) { clearSession(); setSession(null); setChecking(false) } })
    return () => { cancelled = true }
  }, [])

  // 登录/登出（同一文档内）与跨标签页变更时同步会话状态
  useEffect(() => {
    const sync = () => setSession(loadSession())
    window.addEventListener(SESSION_CHANGED_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  // 路由守卫：工作台与管理台需要有效会话；管理台仅限管理员
  useEffect(() => {
    if (checking) return
    if ((route.name === 'app' || route.name === 'admin') && !session && !isDemo()) {
      navigate('/login', { replace: true })
      return
    }
    if (route.name === 'admin' && session && session.user.role !== 'admin') {
      navigate('/app', { replace: true })
    }
  }, [route.name, session, checking])

  if (checking && (route.name === 'app' || route.name === 'admin')) return <Splash />

  switch (route.name) {
    case 'login':
      return <LoginPage key={route.query.get('mode') ?? 'login'} />
    case 'agreement':
      return <AgreementPage />
    case 'admin':
      return session?.user.role === 'admin' ? <AdminPage /> : <Splash text="请使用管理员账号登录…" />
    case 'app':
      return session || isDemo() ? <Workspace /> : <Splash text="正在跳转登录…" />
    default:
      return <LandingPage />
  }
}

const el = document.getElementById('root')
if (!el) throw new Error('root element not found')

const root = import.meta.hot?.data.root ?? createRoot(el)
if (import.meta.hot) import.meta.hot.data.root = root
root.render(
  <StrictMode>
    <Root />
  </StrictMode>
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js') })
}
