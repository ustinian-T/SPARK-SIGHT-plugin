export interface SvgTextBox {
  index: number
  text: string
  x: number
  y: number
  width: number
  height: number
  role?: 'title' | 'subtitle' | 'axis-label' | 'tick-label' | 'legend' | 'annotation' | 'caption' | 'unknown'
}

export interface SvgTextCollision {
  a: SvgTextBox
  b?: SvgTextBox
  kind: 'overlap' | 'out_of_bounds'
  area: number
  suggestion?: string
}

const STRICT_ROLES = new Set(['title', 'subtitle', 'caption'])

export function suggestSvgTextFix(collision: SvgTextCollision): string {
  if (collision.kind === 'out_of_bounds') return '增加画布边距或缩小该文本字号，确保文字完全位于 SVG 视口内。'
  const a = collision.a.role
  const b = collision.b?.role
  if (a === 'title' || b === 'title') return '增加 titleReserve，或将图例移出标题区域。'
  if (a === 'legend' || b === 'legend') return '将图例移到右侧/底部，或减少图例文字长度。'
  if (a === 'tick-label' && b === 'tick-label') return '稀疏化刻度或旋转刻度标签，避免相邻刻度文字重叠。'
  return '增加间距、缩小字号或调整文本锚点，避免文字包围框相交。'
}

function overlapArea(a: SvgTextBox, b: SvgTextBox): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height
}

export function detectSvgTextCollisions(
  boxes: SvgTextBox[],
  bounds: { width: number; height: number },
  padding = 1
): SvgTextCollision[] {
  const collisions: SvgTextCollision[] = []
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i]
    if (box.x < -padding || box.y < -padding || box.x + box.width > bounds.width + padding || box.y + box.height > bounds.height + padding) {
      const collision = { a: box, kind: 'out_of_bounds' as const, area: 0 }
      collisions.push({ ...collision, suggestion: suggestSvgTextFix(collision) })
    }
    for (let j = i + 1; j < boxes.length; j += 1) {
      const other = boxes[j]
      const area = overlapArea(box, other)
      const sameRole = box.role && box.role === other.role
      const strictPair = STRICT_ROLES.has(box.role ?? '') || STRICT_ROLES.has(other.role ?? '')
      if (area > padding && (strictPair || !sameRole || box.role === 'tick-label')) {
        const collision = { a: box, b: other, kind: 'overlap' as const, area }
        collisions.push({ ...collision, suggestion: suggestSvgTextFix(collision) })
      }
    }
  }
  return collisions
}

export function collectRenderedSvgTextCollisions(container: HTMLElement): SvgTextCollision[] {
  const svg = container.querySelector('svg')
  if (!svg) return []
  const svgRect = svg.getBoundingClientRect()
  const boxes: SvgTextBox[] = Array.from(svg.querySelectorAll('text')).map((node, index) => {
    // getBBox() is SVG's native layout measurement and includes glyph metrics
    // even when the element is transformed.  Fall back to the viewport box in
    // test DOMs and browsers that do not expose it for detached SVG nodes.
    const measured = typeof (node as SVGGraphicsElement).getBBox === 'function'
      ? (() => { try { return (node as SVGGraphicsElement).getBBox() } catch { return null } })()
      : null
    const rect = node.getBoundingClientRect()
    const hasNativeBox = measured && measured.width > 0 && measured.height > 0
    let x = rect.left - svgRect.left
    let y = rect.top - svgRect.top
    let width = rect.width
    let height = rect.height
    if (hasNativeBox) {
      const matrix = (node as SVGGraphicsElement).getScreenCTM?.()
      if (matrix && typeof DOMPoint !== 'undefined') {
        const corners = [
          new DOMPoint(measured!.x, measured!.y).matrixTransform(matrix),
          new DOMPoint(measured!.x + measured!.width, measured!.y).matrixTransform(matrix),
          new DOMPoint(measured!.x, measured!.y + measured!.height).matrixTransform(matrix),
          new DOMPoint(measured!.x + measured!.width, measured!.y + measured!.height).matrixTransform(matrix)
        ]
        const left = Math.min(...corners.map((point) => point.x))
        const top = Math.min(...corners.map((point) => point.y))
        const right = Math.max(...corners.map((point) => point.x))
        const bottom = Math.max(...corners.map((point) => point.y))
        x = left - svgRect.left; y = top - svgRect.top; width = right - left; height = bottom - top
      } else {
        x = measured!.x; y = measured!.y; width = measured!.width; height = measured!.height
      }
    }
    const rawRole = node.getAttribute('data-role') ?? node.getAttribute('aria-label')?.split(':')[0] ?? ''
    const svgTitle = svg.getAttribute('aria-label')?.trim()
    const inferredRole = svgTitle && (node.textContent ?? '').trim() === svgTitle ? 'title' : rawRole
    const role = ['title', 'subtitle', 'axis-label', 'tick-label', 'legend', 'annotation', 'caption'].includes(inferredRole)
      ? inferredRole as SvgTextBox['role']
      : 'unknown'
    return {
      index,
      text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      x,
      y,
      width,
      height,
      role
    }
  }).filter((box) => box.text && box.width > 0 && box.height > 0)
  return detectSvgTextCollisions(boxes, { width: svgRect.width, height: svgRect.height }).map((collision) => ({
    ...collision,
    suggestion: collision.suggestion ?? suggestSvgTextFix(collision)
  }))
}

/** 对真实渲染 SVG 做最小白名单清洗，防止脚本、外部资源和事件属性进入 DOM。 */
export function sanitizeSvg(svg: string): string {
  const source = String(svg ?? '')
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
    return source
      .replace(/<\/?(?:script|foreignObject|iframe|object|embed)[^>]*>/gi, '')
      .replace(/\s(on[a-z]+|href|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
  }
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.nodeName.toLowerCase() !== 'svg') return ''
  root.querySelectorAll('script,foreignObject,iframe,object,embed').forEach((node) => node.remove())
  root.querySelectorAll('*').forEach((node) => {
    Array.from(node.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase()
      const value = attr.value.trim()
      if (name.startsWith('on') || ['href', 'xlink:href'].includes(name) && value && !value.startsWith('#')) node.removeAttribute(attr.name)
      if (name === 'style' && /(url\s*\(|javascript:|https?:)/i.test(value)) node.removeAttribute(attr.name)
    })
  })
  return new XMLSerializer().serializeToString(root)
}
