// 最小 RFC 6455 WebSocket 服务端实现（零依赖），仅支持本协议需要的文本帧：
// 握手（Sec-WebSocket-Accept）、客户端帧解掩码、分片合并、ping/pong/close；
// 服务端发送未掩码文本帧。不支持 permessage-deflate（事件均为小 JSON，无需压缩）。
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/** 在已 upgrade 的 socket 上收发帧；返回连接对象 */
export function attachWebSocket(socket) {
  const conn = {
    socket,
    closed: false,
    onMessage: null,
    onClose: null,
    send(payload) {
      if (conn.closed) return
      const data = Buffer.from(payload, 'utf-8')
      conn.socket.write(encodeFrame(OPCODE.TEXT, data))
    },
    ping() {
      if (conn.closed) return
      conn.socket.write(encodeFrame(OPCODE.PING, Buffer.alloc(0)))
    },
    close(code = 1000, reason = '') {
      if (conn.closed) return
      conn.closed = true
      try {
        const r = Buffer.from(reason, 'utf-8')
        const payload = Buffer.alloc(2 + r.length)
        payload.writeUInt16BE(code, 0)
        r.copy(payload, 2)
        conn.socket.end(encodeFrame(OPCODE.CLOSE, payload), () => conn.socket.destroy())
      } catch {
        conn.socket.destroy()
      }
    }
  }

  let buffer = Buffer.alloc(0)
  let fragments = []
  let fragmentedOpcode = -1

  socket.on('data', (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    let frame
    while ((frame = decodeFrame(buffer))) {
      buffer = buffer.slice(frame.totalLength)
      const { opcode, payload } = frame

      if (opcode === OPCODE.PING) {
        if (!conn.closed) socket.write(encodeFrame(OPCODE.PONG, payload))
        continue
      }
      if (opcode === OPCODE.PONG) continue
      if (opcode === OPCODE.CLOSE) {
        conn.closed = true
        let code = 1000
        if (payload.length >= 2) code = payload.readUInt16BE(0)
        try {
          socket.write(encodeFrame(OPCODE.CLOSE, payload))
        } catch {
          /* ignore */
        }
        // 关闭帧发出后销毁底层 socket（升级连接不复用、无后续数据），避免半关闭残留挂住事件循环
        socket.end(() => socket.destroy())
        conn.onClose?.(code)
        return
      }
      if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
        if (fragments.length > 0) {
          // 协议错误：新帧开始时上一帧未结束
          fragments = []
        }
        if (frame.fin) {
          conn.onMessage?.(payload.toString('utf-8'))
        } else {
          fragmentedOpcode = opcode
          fragments.push(payload)
        }
      } else if (opcode === OPCODE.CONTINUATION) {
        fragments.push(payload)
        if (frame.fin) {
          const full = Buffer.concat(fragments)
          fragments = []
          const op = fragmentedOpcode
          fragmentedOpcode = -1
          if (op === OPCODE.TEXT) conn.onMessage?.(full.toString('utf-8'))
        }
      }
    }
  })
  socket.on('close', () => {
    conn.closed = true
    conn.onClose?.(1006)
  })
  socket.on('error', () => {
    conn.closed = true
  })

  return conn
}

function encodeFrame(opcode, payload) {
  const header = [0x80 | opcode]
  const len = payload.length
  if (len < 126) {
    header.push(len)
  } else if (len < 65536) {
    header.push(126, (len >> 8) & 255, len & 255)
  } else {
    header.push(127, 0, 0, 0, 0, 0, 0, 0, 0)
    const big = BigInt(len)
    for (let i = 7; i >= 0; i--) {
      header[1 + 1 + (7 - i)] = Number((big >> BigInt(i * 8)) & 0xffn)
    }
  }
  return Buffer.concat([Buffer.from(header), payload])
}

function decodeFrame(buf) {
  if (buf.length < 2) return null
  const b0 = buf[0]
  const b1 = buf[1]
  const fin = (b0 & 0x80) === 0x80
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) === 0x80
  let len = b1 & 0x7f
  let offset = 2

  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    const big = buf.readBigUInt64BE(2)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null
    len = Number(big)
    offset = 10
  }

  let mask
  if (masked) {
    if (buf.length < offset + 4) return null
    mask = buf.slice(offset, offset + 4)
    offset += 4
  }
  if (buf.length < offset + len) return null

  const payload = Buffer.from(buf.slice(offset, offset + len))
  if (masked) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
  }
  return { fin, opcode, payload, totalLength: offset + len }
}
