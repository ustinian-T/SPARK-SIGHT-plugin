// 临时脚本：提取 docx 正文为 txt（供本轮核对协议，核对后删除）
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const dir = 'E:/deep_imaging_Nexus/doc/doc'
const outDir = 'E:/deep_imaging_Nexus/services/local-agent/.doc-txt'
fs.mkdirSync(outDir, { recursive: true })

function unzip(buf) {
  const files = {}
  let i = buf.length - 22
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--
  let cd = buf.readUInt32LE(i + 16)
  const n = buf.readUInt16LE(i + 10)
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) break
    const method = buf.readUInt16LE(cd + 10)
    const comp = buf.readUInt32LE(cd + 20)
    const nameLen = buf.readUInt16LE(cd + 28)
    const extraLen = buf.readUInt16LE(cd + 30)
    const commLen = buf.readUInt16LE(cd + 32)
    const local = buf.readUInt32LE(cd + 42)
    const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen)
    const lName = buf.readUInt16LE(local + 26)
    const lExtra = buf.readUInt16LE(local + 28)
    const start = local + 30 + lName + lExtra
    const raw = buf.subarray(start, start + comp)
    files[name] = method === 8 ? zlib.inflateRawSync(raw) : raw
    cd += 46 + nameLen + extraLen + commLen
  }
  return files
}

for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.docx')) continue
  const files = unzip(fs.readFileSync(path.join(dir, f)))
  const xml = files['word/document.xml'].toString('utf8')
  const text = xml
    .replace(/<w:p[ >]/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
  fs.writeFileSync(path.join(outDir, f.replace(/\.docx$/, '.txt')), text, 'utf8')
  console.log(f, text.length)
}
