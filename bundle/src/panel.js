/**
 * 本地控制面板（只监听 127.0.0.1，端口默认 18765）。
 *
 * 为什么不做成 DSH 的客户端插件：客户端半需要 dsh.client 构建管线，
 * 改一次 UI 就要重新打包；这里用 node:http 起一个只在本机的页面，
 * 改规则/配额、审草稿、点发送都不用重启 DSH。
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readXlsx } from './xlsx.js'
import { mapWorkbook } from './mapping.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(join(HERE, 'panel.html'), 'utf8')

export function startPanel(opts) {
  const {
    port = 18765,
    host = '127.0.0.1',
    rulesPath,
    statePath,
    draftsPath,
    getStatus,
    run,
    approve,
    skip,
  } = opts

  const readJson = (p, fallback) => {
    try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
  }

  const readDrafts = () => {
    try {
      if (!existsSync(draftsPath)) return []
      const lines = readFileSync(draftsPath, 'utf8').split('\n').filter(Boolean)
      const state = readJson(statePath, { sent: {}, skipped: [] })
      const skipped = new Set((state.skipped ?? []).map((s) => s.commentId))
      const seen = new Set()
      const out = []
      for (const line of lines.slice().reverse()) {
        let d
        try { d = JSON.parse(line) } catch { continue }
        if (!d?.commentId || seen.has(d.commentId)) continue
        seen.add(d.commentId)
        if (skipped.has(d.commentId)) continue
        out.push({ ...d, sent: !!state.sent?.[d.commentId] })
        if (out.length >= 50) break
      }
      return out
    } catch { return [] }
  }

  // 面板会被 DSH 客户端（另一个 origin）调用，必须放行跨域。
  // 只监听回环地址，这里放开 * 不额外扩大暴露面。
  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
  }

  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...CORS })
    res.end(JSON.stringify(obj))
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) reject(new Error('body too large')) })
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })

  // Excel 是二进制，单独读原始字节
  const readRaw = (req) => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 8 * 1024 * 1024) { reject(new Error('文件超过 8MB')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}:${port}`)

      // 预检请求（客户端跨域发 JSON / 二进制时会有）
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PAGE)
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(res, 200, {
          status: await getStatus(),
          rules: readJson(rulesPath, {}),
          rulesPath,
          drafts: readDrafts(),
        })
      }

      // 「开始 / 测试」：立刻返回，任务在后台跑，前端轮询 /api/state 里的 job
      if (req.method === 'POST' && url.pathname === '/api/run') {
        const body = await readBody(req)
        const r = await run(body ?? {})
        return json(res, r?.busy ? 409 : 202, r ?? { ok: true })
      }

      if (req.method === 'POST' && url.pathname === '/api/rules') {
        const body = await readBody(req)
        const cur = readJson(rulesPath, {})
        const next = {
          ...cur,
          keywords: body.keywords ?? cur.keywords ?? [],
          note_gate: { ...(cur.note_gate ?? {}) },
          comment_gate: { ...(cur.comment_gate ?? {}), ...(body.comment_gate ?? {}) },
          reply_policy: { ...(cur.reply_policy ?? {}), ...(body.reply_policy ?? {}) },
          reply_style: { ...(cur.reply_style ?? {}), ...(body.reply_style ?? {}) },
          dry_run: body.dry_run,
          require_approval: typeof body.require_approval === 'boolean' ? body.require_approval : cur.require_approval,
        }
        writeFileSync(rulesPath, JSON.stringify(next, null, 2))
        return json(res, 200, { ok: true, rules: next })
      }

      // 导入客户填的 Excel：?apply=1 才写盘，否则只回预览
      if (req.method === 'POST' && url.pathname === '/api/import') {
        const buf = await readRaw(req)
        if (!buf.length) return json(res, 400, { ok: false, error: '没有收到文件' })
        let mapped
        try {
          mapped = mapWorkbook(readXlsx(buf))
        } catch (e) {
          return json(res, 400, { ok: false, error: `解析失败：${String(e?.message ?? e)}` })
        }
        const apply = url.searchParams.get('apply') === '1'
        if (apply) writeFileSync(rulesPath, JSON.stringify(mapped.rules, null, 2))
        return json(res, 200, {
          ok: true,
          applied: apply,
          filled: Object.keys(mapped.fields).length,
          missing: mapped.missing,
          warnings: mapped.warnings,
          rules: mapped.rules,
        })
      }

      if (req.method === 'POST' && url.pathname === '/api/reply') {
        const body = await readBody(req)
        return json(res, 200, await approve(body))
      }

      if (req.method === 'POST' && url.pathname === '/api/skip') {
        const body = await readBody(req)
        return json(res, 200, await skip(body.commentId))
      }

      json(res, 404, { error: 'not found' })
    } catch (e) {
      json(res, 500, { error: String(e?.message ?? e) })
    }
  })

  server.on('error', () => { /* 端口占用等：静默，不影响插件主功能 */ })
  server.listen(port, host)

  return {
    url: `http://${host}:${port}/`,
    close: () => new Promise((r) => server.close(() => r())),
  }
}
