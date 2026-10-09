// 官网首页：Hero（粒子背景）、产品特性、工作流程、多端协同、安全合规、CTA 与页脚。
import { useEffect, useRef, type ReactNode } from 'react'
import { Particles } from './Particles'
import { SiteFooter, SiteNav } from './Chrome'
import { navigate } from './router'

function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          el.classList.add('is-visible')
          observer.disconnect()
        }
      }
    }, { threshold: 0.12 })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={ref} className="sd-reveal" style={delay ? { transitionDelay: `${delay}ms` } : undefined}>
      {children}
    </div>
  )
}

const FEATURES = [
  { icon: '✦', title: '三方案智能推荐', text: '每次分析并行给出三种可视化方案，含设计依据与统计学证据，选定后仍可随时恢复备选分支。' },
  { icon: '◎', title: '自然语言驱动', text: '用一句中文描述绘图意图，自动完成数据画像、方案设计、代码执行与图表校验的全流程。' },
  { icon: '⌗', title: '多引擎代码生成', text: 'Python · R · MATLAB 三引擎真实执行，生成可复现、可编辑、可二次修改的论文级绘图代码。' },
  { icon: '⇄', title: '数据洞察内置', text: '自动识别字段类型、缺失分布与统计口径，配对检验、效应量等结论附带证据链与核验状态。' },
  { icon: '◈', title: '论文级导出', text: '矢量 SVG/PDF、300DPI 位图与复现 ZIP 一键导出，图表元素支持属性级补丁微调，版本可回溯。' },
  { icon: '❖', title: '隐私优先隔离', text: '账户级数据隔离、口令加盐哈希、传输全程加密；不上云的数据 7 天自动清除，上云空间独立配额。' }
]

const STEPS = [
  { title: '上传数据', text: '拖入 CSV / Excel，自动完成数据画像与质量检查，无需预处理脚本。' },
  { title: '描述意图', text: '用自然语言说明想展示的结论，或直接让智能体推荐最合适的表达。' },
  { title: '比较方案', text: '三套方案同屏对比设计思路与代码实现，选择、反馈或手动微调。' },
  { title: '导出发表', text: '导出高清图表与完整复现包，审稿返修时基于历史版本继续迭代。' }
]

export function LandingPage() {
  return (
    <div className="sd-root">
      <Particles />
      <div className="sd-shell">
        <SiteNav />

        {/* Hero */}
        <section className="sd-hero">
          <div className="sd-hero__glow" />
          <div className="sd-container sd-hero__inner">
            <span className="sd-eyebrow">科研绘图智能体 · AI 驱动</span>
            <h1>
              让数据开口说话
              <br />
              <span className="grad">让图表成为作品</span>
            </h1>
            <p className="sd-hero__sub">
              灵感视界 SPARK SIGHT 将数据分析、方案设计与论文级绘图融为一体。
              一次上传，三套方案，全部可复现 —— 科研绘图从未如此从容。
            </p>
            <div className="sd-hero__cta">
              <a className="sd-btn sd-btn--primary" href="#/login?mode=register">免费开始使用</a>
              <a className="sd-btn sd-btn--ghost" href="#features" onClick={(e) => { e.preventDefault(); document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' }) }}>了解产品特性</a>
            </div>
            <div className="sd-hero__stats">
              <div className="sd-hero__stat"><b>3 套</b><span>并行智能绘图方案</span></div>
              <div className="sd-hero__stat"><b>3 引擎</b><span>Python / R / MATLAB</span></div>
              <div className="sd-hero__stat"><b>300 DPI</b><span>论文级导出精度</span></div>
              <div className="sd-hero__stat"><b>300 MB</b><span>用户云端项目空间</span></div>
            </div>
          </div>
        </section>

        {/* 产品特性 */}
        <section className="sd-section" id="features">
          <div className="sd-container">
            <Reveal>
              <div className="sd-section__head sd-section--center" style={{ textAlign: 'center', margin: '0 auto' }}>
                <span className="sd-eyebrow">产品特性</span>
                <h2 className="sd-h2">强大的能力，简洁的体验</h2>
                <p className="sd-lead">从数据到成图的全链路智能编排，每一步都可见、可改、可回溯。</p>
              </div>
            </Reveal>
            <div className="sd-grid sd-grid--3">
              {FEATURES.map((feature, index) => (
                <Reveal key={feature.title} delay={index * 60}>
                  <div className="sd-card sd-feature">
                    <div className="sd-feature__icon">{feature.icon}</div>
                    <h3>{feature.title}</h3>
                    <p>{feature.text}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* 工作流程 */}
        <section className="sd-section" id="workflow" style={{ paddingTop: 40 }}>
          <div className="sd-container">
            <Reveal>
              <div className="sd-section__head" style={{ textAlign: 'center', margin: '0 auto' }}>
                <span className="sd-eyebrow">工作流程</span>
                <h2 className="sd-h2">四步，从原始数据到发表级图表</h2>
              </div>
            </Reveal>
            <div className="sd-steps">
              {STEPS.map((step, index) => (
                <Reveal key={step.title} delay={index * 70}>
                  <div className="sd-card sd-step">
                    <h3>{step.title}</h3>
                    <p>{step.text}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* 多端协同 */}
        <section className="sd-section" id="ecosystem" style={{ paddingTop: 40 }}>
          <div className="sd-container">
            <Reveal>
              <div className="sd-section__head" style={{ textAlign: 'center', margin: '0 auto' }}>
                <span className="sd-eyebrow">多端协同</span>
                <h2 className="sd-h2">一个账号，处处开工</h2>
                <p className="sd-lead">网页端、桌面端与 IDE 插件登录同一账号，云端项目数据无缝共享。</p>
              </div>
            </Reveal>
            <div className="sd-eco">
              <Reveal>
                <div className="sd-card sd-eco__main">
                  <span className="sd-eco__tag">WEB</span>
                  <h3>网页端 · 全功能主阵地</h3>
                  <p>注册登录即用，对话式创建任务、比较方案、审阅代码与证据，项目支持一键上云，在任意设备继续未完成的工作。</p>
                  <div>
                    <a className="sd-btn sd-btn--primary sd-btn--sm" href="#/login">立即体验</a>
                  </div>
                </div>
              </Reveal>
              <Reveal delay={80}>
                <div className="sd-card sd-eco__side">
                  <span className="sd-eco__tag">DESKTOP</span>
                  <h3>桌面端</h3>
                  <p>本地引擎直连，敏感数据可留驻本机；支持 MATLAB 等本机运行时，管理员可在桌面端进行账号管理。</p>
                  <a className="sd-eco__link" href="#/login">使用账号登录 →</a>
                </div>
              </Reveal>
              <Reveal delay={160}>
                <div className="sd-card sd-eco__side">
                  <span className="sd-eco__tag">IDE PLUGIN</span>
                  <h3>编辑器插件</h3>
                  <p>在 VS Code 中随写随绘，绘图结果与云端项目实时同步；注册引导至网页端，账号体系统一。</p>
                  <a className="sd-eco__link" href="#/login">使用账号登录 →</a>
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* 安全与合规 */}
        <section className="sd-section" id="security" style={{ paddingTop: 40 }}>
          <div className="sd-container">
            <Reveal>
              <div className="sd-section__head" style={{ textAlign: 'center', margin: '0 auto' }}>
                <span className="sd-eyebrow">安全与合规</span>
                <h2 className="sd-h2">您的数据，由您掌控</h2>
              </div>
            </Reveal>
            <Reveal delay={60}>
              <div className="sd-security">
                <div className="sd-security__item"><b>账户级数据隔离</b><span>项目、任务与生成内容严格按用户隔离，互不可见，隐私安全默认内置。</span></div>
                <div className="sd-security__item"><b>默认不上云</b><span>数据默认保留在本机实例；未上云数据仅保留 7 天，期满自动清除。</span></div>
                <div className="sd-security__item"><b>上云独立配额</b><span>主动上云的项目享有独立 300 MB 云空间，云端数据多端共享、随时可撤。</span></div>
                <div className="sd-security__item"><b>合规与标识</b><span>遵循生成式 AI 服务管理规定，AI 生成内容携带标识与证据链，可追溯核验。</span></div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* CTA */}
        <section className="sd-section" style={{ paddingTop: 24 }}>
          <div className="sd-container">
            <Reveal>
              <div className="sd-cta">
                <h2>现在，让下一张图表与众不同</h2>
                <p>注册即享三方案智能绘图与 300 MB 云端项目空间。</p>
                <div className="sd-hero__cta">
                  <button className="sd-btn sd-btn--primary" onClick={() => navigate('/login?mode=register')}>免费注册</button>
                  <button className="sd-btn sd-btn--ghost" onClick={() => navigate('/login')}>登录已有账号</button>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        <SiteFooter />
      </div>
    </div>
  )
}
