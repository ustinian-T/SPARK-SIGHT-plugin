// 站点背景：暗色画布上均匀散布、缓慢漂移的淡绿色粒子（参考 corexpertdata 的粒子场）。
// 粒子彼此独立、无“聚集”规则，因此始终均匀铺开、不会抱成团；仅当两颗恰好靠近时淡淡地
// 连一条线（占少数），鼠标附近的粒子会被轻轻吸引并连线，营造跟随交互。
// respects prefers-reduced-motion：静态渲染一帧。
import { useEffect, useRef } from 'react'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  base: number
  phase: number
}

const PARTICLE_COLOR = '125, 240, 180' // 淡绿 (r,g,b)

export function Particles({ className = '', density = 3600, maxCount = 400 }: { className?: string; density?: number; maxCount?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let particles: Particle[] = []
    let width = 0
    let height = 0
    let raf = 0
    let running = true
    const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999, active: false }
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    // 抖动网格布点：保证整体均匀铺开（不会随机聚成一团），同时保留自然的随机感。
    const seed = () => {
      const count = Math.max(60, Math.min(maxCount, Math.round((width * height) / density)))
      const cols = Math.max(1, Math.round(Math.sqrt(count * (width / height))))
      const rows = Math.max(1, Math.ceil(count / cols))
      const cw = width / cols
      const ch = height / rows
      particles = []
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          particles.push({
            x: c * cw + cw * 0.5 + (Math.random() - 0.5) * cw * 0.8,
            y: r * ch + ch * 0.5 + (Math.random() - 0.5) * ch * 0.8,
            vx: (Math.random() - 0.5) * 0.28,
            vy: (Math.random() - 0.5) * 0.28,
            r: 0.7 + Math.random() * 1.5,
            base: 0.3 + Math.random() * 0.5,
            phase: Math.random() * Math.PI * 2
          })
        }
      }
    }

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = rect.width
      height = rect.height
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      seed()
    }

    // 连线与鼠标半径：连线半径不大，均匀场中只有恰好相邻的少数粒子相连
    const LINK = 88
    const MOUSE_RADIUS = 165
    const MOUSE_LINK_R = MOUSE_RADIUS * 0.62

    const draw = () => {
      ctx.clearRect(0, 0, width, height)

      // 鼠标跟随的柔和辉光（很淡）
      if (mouse.active) {
        const glow = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, 190)
        glow.addColorStop(0, `rgba(${PARTICLE_COLOR}, 0.06)`)
        glow.addColorStop(1, `rgba(${PARTICLE_COLOR}, 0)`)
        ctx.fillStyle = glow
        ctx.fillRect(mouse.x - 190, mouse.y - 190, 380, 380)
      }

      // 近距粒子连线（均匀、稀疏）
      ctx.lineWidth = 0.7
      const lk2 = LINK * LINK
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i]
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const d2 = dx * dx + dy * dy
          if (d2 < lk2) {
            const alpha = (1 - Math.sqrt(d2) / LINK) * 0.13
            ctx.strokeStyle = `rgba(${PARTICLE_COLOR}, ${alpha.toFixed(3)})`
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
        // 鼠标与邻近粒子的连线（跟随感）
        if (mouse.active) {
          const dx = a.x - mouse.x
          const dy = a.y - mouse.y
          const dist = Math.hypot(dx, dy)
          if (dist < MOUSE_LINK_R) {
            const alpha = (1 - dist / MOUSE_LINK_R) * 0.17
            ctx.strokeStyle = `rgba(${PARTICLE_COLOR}, ${alpha.toFixed(3)})`
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(mouse.x, mouse.y)
            ctx.stroke()
          }
        }
      }

      // 独立漂移：轻微随机扰动 + 高阻尼的缓慢滑行；无聚集，保持均匀
      for (const p of particles) {
        if (mouse.active) {
          const dx = mouse.x - p.x
          const dy = mouse.y - p.y
          const dist = Math.hypot(dx, dy)
          if (dist < MOUSE_RADIUS && dist > 0.001) {
            const force = (1 - dist / MOUSE_RADIUS) * 0.018
            p.vx += (dx / dist) * force
            p.vy += (dy / dist) * force
          }
        }
        p.vx += (Math.random() - 0.5) * 0.012
        p.vy += (Math.random() - 0.5) * 0.012
        p.vx *= 0.985
        p.vy *= 0.985
        if (!reduced) {
          p.x += p.vx
          p.y += p.vy
        }
        if (p.x < -8) p.x = width + 8
        if (p.x > width + 8) p.x = -8
        if (p.y < -8) p.y = height + 8
        if (p.y > height + 8) p.y = -8
      }

      // 粒子本体（轻微呼吸闪烁）
      const t = performance.now() / 1000
      for (const p of particles) {
        const twinkle = 0.75 + 0.25 * Math.sin(t * 1.4 + p.phase)
        const alpha = Math.min(1, p.base * twinkle)
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${PARTICLE_COLOR}, ${alpha.toFixed(3)})`
        ctx.fill()
      }
    }

    const loop = () => {
      if (!running) return
      draw()
      raf = requestAnimationFrame(loop)
    }

    resize()
    if (reduced) {
      draw() // 静态一帧
    } else {
      raf = requestAnimationFrame(loop)
    }

    const onMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      mouse.tx = event.clientX - rect.left
      mouse.ty = event.clientY - rect.top
      if (!mouse.active) { mouse.x = mouse.tx; mouse.y = mouse.ty }
      mouse.active = true
    }
    const onLeave = () => { mouse.active = false; mouse.x = -9999; mouse.y = -9999 }
    const onVisibility = () => {
      if (reduced) return
      if (document.hidden) {
        running = false
        cancelAnimationFrame(raf)
      } else if (!running) {
        running = true
        raf = requestAnimationFrame(loop)
      }
    }
    // 鼠标位置的缓动跟随（更顺滑的吸引感）
    const ease = window.setInterval(() => {
      mouse.x += (mouse.tx - mouse.x) * 0.12
      mouse.y += (mouse.ty - mouse.y) * 0.12
    }, 16)

    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerleave', onLeave)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      window.clearInterval(ease)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [density, maxCount])

  return <canvas ref={canvasRef} className={`sd-particles ${className}`} aria-hidden="true" />
}
