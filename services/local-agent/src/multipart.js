// 轻量 multipart/form-data 解析（零依赖）。
// 文件部分保留原始 Buffer（编码探测与 SHA256 指纹必须基于原始字节），字段部分按 UTF-8 解码。

export class MultipartError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MultipartError'
    this.code = code
  }
}

const CRLF = Buffer.from('\r\n')
const DOUBLE_CRLF = Buffer.from('\r\n\r\n')

/**
 * @param {Buffer} body
 * @param {string} boundary 不含前导 "--"
 * @returns {{fields: Record<string,string>, files: Array<{field:string,fileName:string,contentType:string,buffer:Buffer}>}}
 */
export function parseMultipart(body, boundary) {
  if (!boundary) throw new MultipartError('BAD_BOUNDARY', '缺少 multipart boundary')
  const delimiter = Buffer.from(`--${boundary}`)
  const fields = {}
  const files = []

  let pos = body.indexOf(delimiter)
  if (pos < 0) throw new MultipartError('MALFORMED', '未找到 multipart 起始边界')

  while (pos >= 0) {
    let headerStart = pos + delimiter.length
    // 结束边界 "--"：delimiter 后紧跟 "--"
    if (body.slice(headerStart, headerStart + 2).toString('binary') === '--') break
    if (body.slice(headerStart, headerStart + 2).equals(CRLF)) headerStart += 2
    const headerEnd = body.indexOf(DOUBLE_CRLF, headerStart)
    if (headerEnd < 0) break

    const terminator = body.indexOf(Buffer.concat([CRLF, delimiter]), headerEnd + 4)
    if (terminator < 0) break

    const rawHeaders = body.slice(headerStart, headerEnd).toString('utf-8')
    const content = body.slice(headerEnd + 4, terminator)
    const headers = parsePartHeaders(rawHeaders)

    if (headers.filename !== undefined) {
      files.push({
        field: headers.name,
        fileName: headers.filename,
        contentType: headers.contentType ?? 'application/octet-stream',
        buffer: content
      })
    } else if (headers.name) {
      fields[headers.name] = content.toString('utf-8')
    }

    // 下一轮从紧接的边界开始（terminator+2 即边界首字节）
    pos = body.indexOf(delimiter, terminator + 2)
  }

  return { fields, files }
}

function parsePartHeaders(raw) {
  const out = {}
  const seen = new Set()
  raw.split(/\r\n/).forEach((line) => {
    const idx = line.indexOf(':')
    if (idx <= 0) throw new MultipartError('INVALID_MULTIPART_HEADER', 'multipart 头格式非法')
    const name = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (!/^[a-z0-9-]+$/.test(name) || seen.has(name)) {
      throw new MultipartError('INVALID_MULTIPART_HEADER', 'multipart 头重复或包含非法字符')
    }
    seen.add(name)
    if (name === 'content-disposition') {
      const nameMatch = /name="([^"]*)"/.exec(value)
      const fileMatch = /filename\*?="([^"]*)"/.exec(value)
      if (nameMatch) out.name = nameMatch[1]
      if (fileMatch) out.filename = decodeFilename(fileMatch[1])
    } else if (name === 'content-type') {
      out.contentType = value
    }
  })
  if (!seen.has('content-disposition')) throw new MultipartError('INVALID_MULTIPART_HEADER', '缺少 Content-Disposition')
  return out
}

// RFC 5987 filename*=UTF-8''%xx 兜底
function decodeFilename(name) {
  if (/^UTF-8''/i.test(name)) {
    try {
      return decodeURIComponent(name.slice(7))
    } catch {
      return name
    }
  }
  return name
}

/** 读取请求体并施加大小上限（NFR：超大文件不得拖垮服务） */
export function readBody(req, maxBytes, res) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let aborted = false
    const rejectTooLarge = () => {
      if (aborted) return
      aborted = true
      const err = new MultipartError('PAYLOAD_TOO_LARGE', `上传体积超过上限 ${maxBytes} 字节`)
      // 先给出稳定 413 响应，再销毁连接停止继续上传（客户端可读到状态码）
      if (res && !res.headersSent) {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', connection: 'close' })
        res.end(JSON.stringify({ error: { code: err.code, message: err.message } }))
      }
      req.destroy()
      reject(err)
    }
    req.on('data', (chunk) => {
      if (aborted) return
      size += chunk.length
      if (size > maxBytes) {
        rejectTooLarge()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => !aborted && resolve(Buffer.concat(chunks)))
    req.on('error', (e) => {
      if (aborted) return
      // 客户端在收到 413 后中断上传属于预期行为
      if (res?.headersSent) {
        aborted = true
        reject(new MultipartError('PAYLOAD_TOO_LARGE', '上传体积超过上限'))
        return
      }
      reject(e)
    })
  })
}
