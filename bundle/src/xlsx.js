/**
 * 极简 .xlsx 读取器（零依赖）。
 *
 * xlsx 就是一个 zip：xl/workbook.xml + xl/sharedStrings.xml + xl/worksheets/sheetN.xml。
 * 这里实现最小可用的 ZIP 中央目录解析 + inflateRaw，足够读我们自己模板生成的文件
 * （openpyxl / Excel 保存的都吃；不支持加密、不支持 .xls）。
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

function readZipEntries(buf) {
  // 从尾部往前找 EOCD（最多 64KB 注释）
  let eocd = -1
  const start = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 ZIP 目录）')

  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = new Map()

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) break
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)

    if (buf.readUInt32LE(localOff) === LOC_SIG) {
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      const raw = buf.subarray(dataStart, dataStart + compSize)
      if (method === 0) entries.set(name, raw)
      else if (method === 8) {
        try { entries.set(name, inflateRawSync(raw)) } catch { /* 跳过坏条目 */ }
      }
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

const decodeXml = (s) => s
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&')

function parseSharedStrings(xml) {
  if (!xml) return []
  const out = []
  const items = xml.match(/<si\b[\s\S]*?<\/si>/g) || []
  for (const si of items) {
    const texts = [...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]))
    out.push(texts.join(''))
  }
  return out
}

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '')
  if (!m) return 0
  let n = 0
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function parseSheet(xml, shared) {
  const rows = []
  const rowMatches = xml.match(/<row\b[\s\S]*?<\/row>/g) || []
  for (const rowXml of rowMatches) {
    const cells = []
    const cellMatches = rowXml.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []
    for (const cXml of cellMatches) {
      const ref = /\br="([^"]+)"/.exec(cXml)?.[1] ?? ''
      const type = /\bt="([^"]+)"/.exec(cXml)?.[1] ?? ''
      let value = ''
      if (type === 'inlineStr') {
        const t = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cXml)
        value = t ? decodeXml(t[1]) : ''
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cXml)
        if (v) {
          value = type === 's' ? (shared[Number(v[1])] ?? '') : decodeXml(v[1])
        }
      }
      cells[colIndex(ref)] = value
    }
    rows.push(cells)
  }
  return rows
}

/** @returns {{name:string, rows:string[][]}[]} */
export function readXlsx(buf) {
  const entries = readZipEntries(buf)
  const shared = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'))

  const wbXml = entries.get('xl/workbook.xml')?.toString('utf8') ?? ''
  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''

  const rels = new Map()
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0]
    const id = /\bId="([^"]+)"/.exec(tag)?.[1]
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1]
    if (id && target) rels.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''))
  }

  const sheets = []
  const sheetTags = wbXml.match(/<sheet\b[^>]*>/g) || []
  for (const tag of sheetTags) {
    const name = decodeXml(/\bname="([^"]*)"/.exec(tag)?.[1] ?? 'Sheet')
    const rid = /\br:id="([^"]+)"/.exec(tag)?.[1]
    const target = rid ? rels.get(rid) : null
    const path = target ? (target.startsWith('xl/') ? target : `xl/${target}`) : null
    const xml = path ? entries.get(path)?.toString('utf8') : null
    if (!xml) continue
    sheets.push({ name, rows: parseSheet(xml, shared) })
  }

  // 兜底：workbook.xml 解析失败时按文件名读
  if (!sheets.length) {
    for (const [name, data] of entries) {
      const m = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(name)
      if (m) sheets.push({ name: `Sheet${m[1]}`, rows: parseSheet(data.toString('utf8'), shared) })
    }
  }
  return sheets
}
