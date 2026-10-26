// 站点公共部件：品牌标识、顶部导航、页脚（含 ICP 备案与公安联网备案）。
import { useEffect, useState } from 'react'
import { navigate } from './router'

export const ICP_NUMBER = 'ICP备-示例-0000000号'
export const ICP_URL = 'https://beian.miit.gov.cn/'
export const GONGWANG_NUMBER = '公网安备-示例-00000000000号'
export const GONGWANG_URL = 'https://beian.mps.gov.cn/'
export const COPYRIGHT = '© 2026 redacted'

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <a className="sd-brand" href="#/" onClick={(e) => { e.preventDefault(); navigate('/') }}>
      <img src="/logo-dark.png" alt="灵感视界 SPARK SIGHT" />
      <span>
        <span className="sd-brand__cn">灵感视界</span>
        {!compact && <small>SPARK SIGHT</small>}
      </span>
    </a>
  )
}

export function SiteNav({ active }: { active?: 'features' | 'workflow' | 'ecosystem' | 'security' }) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  const anchor = (id: string) => (event: React.MouseEvent) => {
    event.preventDefault()
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <header className={`sd-nav ${scrolled ? 'sd-nav--scrolled' : ''}`}>
      <div className="sd-container sd-container--wide sd-nav__inner">
        <BrandMark />
        <nav className="sd-nav__links">
          <a href="#features" onClick={anchor('features')}>产品特性</a>
          <a href="#workflow" onClick={anchor('workflow')}>工作流程</a>
          <a href="#ecosystem" onClick={anchor('ecosystem')}>多端协同</a>
          <a href="#security" onClick={anchor('security')}>安全与合规</a>
        </nav>
        <div className="sd-nav__cta">
          <a className="sd-btn sd-btn--ghost sd-btn--sm" href="#/login">登录</a>
          <a className="sd-btn sd-btn--primary sd-btn--sm" href="#/login?mode=register">免费注册</a>
        </div>
      </div>
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="sd-footer">
      <div className="sd-container">
        <div className="sd-footer__grid">
          <div className="sd-footer__brand">
            <BrandMark compact />
            <p>科研绘图智能体 —— 从数据到论文级图表，让每一次分析都被看见。</p>
          </div>
          <div className="sd-footer__cols">
            <div>
              <h4>产品</h4>
              <a href="#features">产品特性</a>
              <a href="#workflow">工作流程</a>
              <a href="#/login">立即使用</a>
            </div>
            <div>
              <h4>支持</h4>
              <a href="#/agreement">用户协议</a>
              <a href="#/agreement">隐私政策</a>
              <a href="mailto:contact@example.com">联系我们</a>
            </div>
          </div>
        </div>
        <div className="sd-footer__beian">
          <a className="sd-footer__beain-link" href={ICP_URL} target="_blank" rel="noopener noreferrer">{ICP_NUMBER}</a>
          <a className="sd-footer__beain-link" href={GONGWANG_URL} target="_blank" rel="noopener noreferrer">
            <img src="/beian-gongan.png" alt="公安备案图标" />
            <span>{GONGWANG_NUMBER}</span>
          </a>
          <span className="sd-footer__copy">{COPYRIGHT}</span>
        </div>
      </div>
    </footer>
  )
}
