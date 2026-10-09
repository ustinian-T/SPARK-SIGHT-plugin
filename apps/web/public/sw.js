const CACHE = 'spark-sight-shell-v3'
const CORE = ['/', '/manifest.webmanifest', '/icons/favicon-32.png']

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)).catch(() => {}))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // 仅处理同源 GET；跨域、非 GET 直接放行。
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return
  // 关键：API / 鉴权 / 云存储请求一律直连网络，绝不缓存、也不做离线 HTML 回退，
  // 否则会把 HTML 外壳当作 JSON 返回，导致登录态校验与数据请求异常。
  if (url.pathname.startsWith('/api/')) return
  // 静态资源与页面导航：network-first，离线时对导航请求回退到外壳，其余回退到缓存副本。
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {})
        }
        return response
      })
      .catch(() =>
        caches.match(event.request).then((cached) => cached ?? (event.request.mode === 'navigate' ? caches.match('/') : undefined))
      )
  )
})
