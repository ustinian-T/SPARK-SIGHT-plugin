// 极简 hash 路由：#/（官网）、#/login、#/agreement、#/admin、#/app（工作台）。
// 不引入路由依赖，保持 web 包零新增运行时依赖。
import { useEffect, useState } from 'react'

export type SiteRouteName = 'landing' | 'login' | 'agreement' | 'admin' | 'app'

export interface SiteRoute {
  name: SiteRouteName
  query: URLSearchParams
}

export function parseHash(raw: string): SiteRoute {
  const hash = String(raw ?? '').replace(/^#/, '')
  const [path, query = ''] = hash.split('?')
  const name = path.replace(/\/+$/, '') || '/'
  switch (name) {
    case '/login': return { name: 'login', query: new URLSearchParams(query) }
    case '/agreement': return { name: 'agreement', query: new URLSearchParams(query) }
    case '/admin': return { name: 'admin', query: new URLSearchParams(query) }
    case '/app': return { name: 'app', query: new URLSearchParams(query) }
    default: return { name: 'landing', query: new URLSearchParams(query) }
  }
}

export function currentRoute(): SiteRoute {
  return parseHash(window.location.hash)
}

export function navigate(to: string, { replace = false } = {}): void {
  const target = to.startsWith('#') ? to : `#${to}`
  if (replace) {
    const url = new URL(window.location.href)
    url.hash = target
    window.location.replace(url.href)
  }
  else window.location.hash = target
}

export function useHashRoute(): SiteRoute {
  const [route, setRoute] = useState<SiteRoute>(() => currentRoute())
  useEffect(() => {
    const onChange = () => {
      setRoute(currentRoute())
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
