/**
 * SPARK SIGHT for DeepSeek Harness — Client half.
 *
 * Registered through the browser Module Loader; React / react-dom come from
 * the Harness module table (no bundled/duplicate React).
 *
 * M2: renders an "open workbench" button in the conversation input toolbar.
 * Clicking it fetches the Host's `/api/sparksight/stage` route for the
 * sidecar webUrl, then opens a full-screen overlay whose iframe embeds the
 * same-origin hosted SPARK SIGHT web app (login -> full workbench).
 */
window.__ModuleLoader__.load({
  id: 'sparksight-dsh',
  factory(require) {
    const React = require('react')
    const ReactDom = require('react-dom')
    const { useEffect, useRef, useState } = React
    const h = React.createElement

    const INK = '#12324B'
    const TEAL = '#2A9D8F'

    function SparkGlyph({ size = 16 }) {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M12 2 L14.2 9.8 L22 12 L14.2 14.2 L12 22 L9.8 14.2 L2 12 L9.8 9.8 Z',
          fill: TEAL,
        })
      )
    }

    function StageOverlay({ webUrl, onClose }) {
      const iframeRef = useRef(null)

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      // M3：iframe <-> 本机 Agent 的 host-bridge 中继。
      // iframe 注入的 bootstrap 以 postMessage 发来 HostMessage；转发到同源
      // POST /api/sparksight/host，再把 HostResponse 以精确 iframe origin 回发
      //（响应含 Agent 令牌，绝不使用 '*' targetOrigin）。
      useEffect(() => {
        const iframe = iframeRef.current
        if (!iframe) return
        const iframeOrigin = new URL(webUrl).origin
        const onMessage = async (event) => {
          if (event.source !== iframe.contentWindow || event.origin !== iframeOrigin) return
          const message = event.data
          if (!message || typeof message.id !== 'string' || !message.type) return
          const reply = (payload) => {
            if (iframe.contentWindow) iframe.contentWindow.postMessage(payload, iframeOrigin)
          }
          try {
            const response = await fetch('/api/sparksight/host', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(message),
            })
            reply(await response.json())
          } catch {
            reply({ version: 2, id: message.id, ok: false, error: { code: 'HOST_RELAY_FAILED', message: 'host relay failed' } })
          }
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [webUrl])

      return h(
        'div',
        {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': 'SPARK SIGHT 工作台',
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: 'rgba(9,20,30,0.55)',
            display: 'flex',
            flexDirection: 'column',
            padding: 'clamp(10px, 3vw, 42px)',
          },
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          {
            style: {
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              background: '#fff',
              borderRadius: 14,
              overflow: 'hidden',
              boxShadow: '0 26px 70px rgba(8,20,30,0.38)',
            },
          },
          h(
            'div',
            {
              style: {
                flex: '0 0 auto',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                background: INK,
                color: '#fff',
              },
            },
            h(SparkGlyph, { size: 18 }),
            h('span', { style: { fontWeight: 700, fontSize: 14, letterSpacing: '0.4px' } }, '灵感视界 SPARK SIGHT'),
            h('span', { style: { fontSize: 11, color: '#9FB6C4', letterSpacing: '1px' } }, '科研绘图工作台'),
            h(
              'button',
              {
                type: 'button',
                'aria-label': '关闭',
                onClick: onClose,
                style: {
                  marginLeft: 'auto',
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  border: 'none',
                  background: 'rgba(255,255,255,0.12)',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: 15,
                },
              },
              '✕'
            )
          ),
          h('iframe', {
            ref: iframeRef,
            src: `${webUrl}/#/app`,
            title: 'SPARK SIGHT Stage',
            allow: 'clipboard-read; clipboard-write; fullscreen',
            style: { flex: 1, width: '100%', minHeight: 0, border: 'none', background: '#fff' },
          })
        )
      )
    }

    function StageButton() {
      const [open, setOpen] = useState(false)
      const [webUrl, setWebUrl] = useState('')
      const [error, setError] = useState('')
      const [update, setUpdate] = useState(null)
      const [checking, setChecking] = useState(false)
      const [downloading, setDownloading] = useState(false)
      const downloadUpgrade = async () => {
        setDownloading(true); setError('')
        try {
          const response = await fetch('/api/sparksight/update-package', { cache: 'no-store' })
          if (!response.ok) { const result = await response.json(); throw new Error(result.error || '下载失败') }
          const url = URL.createObjectURL(await response.blob())
          const link = document.createElement('a'); link.href = url; link.download = 'Spark-Sight-DSH.tgz'; link.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        } catch (error) { setError(error.message) } finally { setDownloading(false) }
      }
      const checkUpdates = async () => {
        setChecking(true); setError('')
        try {
          const response = await fetch('/api/sparksight/updates', { cache: 'no-store' })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error || '检查更新失败')
          setUpdate(data)
        } catch (error) { setError(error.message) } finally { setChecking(false) }
      }

      const openStage = async () => {
        setError('')
        try {
          const response = await fetch('/api/sparksight/stage', { cache: 'no-store' })
          const data = await response.json().catch(() => ({}))
          if (!response.ok || !data.webUrl) {
            throw new Error(data.ready === false ? '工作台正在启动，请稍后重试' : '工作台暂不可用')
          }
          setWebUrl(data.webUrl)
          setOpen(true)
        } catch (err) {
          setError(err.message)
        }
      }

      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
        h(
          'button',
          {
            type: 'button',
            onClick: openStage,
            title: '打开 SPARK SIGHT 工作台',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 11px',
              border: '1px solid rgba(42,157,143,0.45)',
              background: 'rgba(42,157,143,0.10)',
              borderRadius: 16,
              cursor: 'pointer',
              color: INK,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.6px',
            },
          },
          h(SparkGlyph, { size: 14 }),
          'SPARK SIGHT'
        ),
        h('button', { type: 'button', disabled: checking, onClick: checkUpdates, title: '检查 DSH 插件更新' }, checking ? '检查中…' : '更新'),
        update ? h('span', { style: { fontSize: 11, maxWidth: 400 } },
          update.release ? h('span', null, `新版 ${update.release.version} · `,
            h('button', { type: 'button', disabled: downloading, onClick: downloadUpgrade }, downloading ? '正在校验并下载…' : '下载并校验升级包'),
            '；解压后运行 dsh plugin --profile desktop add <解压目录/package>（网页宿主使用 --profile web），完成后重启 Harness。保留原有 dataDir。')
            : `当前 ${update.currentVersion} 已是最新版本`) : null,
        error ? h('span', { style: { fontSize: 11, color: '#C0392B' } }, error) : null,
        open && webUrl
          ? ReactDom.createPortal(h(StageOverlay, { webUrl, onClose: () => setOpen(false) }), document.body)
          : null
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => {
          return ctx.slots.register(
            { name: 'conversation.input.left', id: 'sparksight-dsh', order: 5 },
            StageButton
          )
        })
      },
    }
  },
})
