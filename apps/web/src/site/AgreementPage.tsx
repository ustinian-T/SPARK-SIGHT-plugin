// 《用户协议与隐私政策》独立全文页。
import { Particles } from './Particles'
import { BrandMark, SiteFooter } from './Chrome'
import { AgreementDocument } from './AgreementDocument'

export function AgreementPage() {
  return (
    <div className="sd-root">
      <Particles />
      <div className="sd-shell">
        <header className="sd-nav sd-nav--scrolled">
          <div className="sd-container sd-container--wide sd-nav__inner">
            <BrandMark />
            <nav className="sd-nav__links" />
            <div className="sd-nav__cta">
              <a className="sd-btn sd-btn--ghost sd-btn--sm" href="#/">返回官网</a>
              <a className="sd-btn sd-btn--primary sd-btn--sm" href="#/login">登录 / 注册</a>
            </div>
          </div>
        </header>
        <main className="sd-doc sd-container">
          <AgreementDocument withToc />
        </main>
        <SiteFooter />
      </div>
    </div>
  )
}
