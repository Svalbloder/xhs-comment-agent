/**
 * 本地控制面板（只监听 127.0.0.1，端口默认 18765）。
 *
 * 为什么不做成 DSH 的客户端插件：客户端半需要 dsh.client 构建管线，
 * 改一次 UI 就要重新打包；这里用 node:http 起一个只在本机的页面，
 * 改规则/配额、审草稿、点发送都不用重启 DSH。
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 小红书笔记页地址：带 xsec_token 才能打开（否则会提示笔记不存在）
const noteUrl = (feedId, token) =>
  `https://www.xiaohongshu.com/explore/${encodeURIComponent(feedId)}` +
  (token ? `?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_search` : '')

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE_PATH = join(HERE, 'panel.html')
// 每次请求现读 panel.html：原来 import 时读一次，改一行 UI 就得重启整个宿主。
const readPage = () => {
  try { return readFileSync(PAGE_PATH, 'utf8') } catch { return '<h1>panel.html 缺失</h1>' }
}

export function startPanel(opts) {
  const {
    port = 18765,
    host = '127.0.0.1',
    token = '',
    rulesPath,
    statePath,
    draftsPath,
    scriptsPath,
    getScripts,
    saveScripts,
    openLoginWindow,
    getStatus,
    run,
    control,
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

  // ---- 访问控制 ----
  // 本机（回环）不受限，保持 DSH 右侧栏与本地浏览器照常可用；
  // 从局域网 / Tailscale 进来的一律要求令牌，且不允许触发真实发送。
  const remoteIp = (req) => String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
  const isLocal = (req) => remoteIp(req) === '127.0.0.1' || remoteIp(req) === '::1'
  const cookieToken = (req) => {
    const m = String(req.headers.cookie || '').match(/(?:^|;\s*)xhs_token=([^;]*)/)
    return m ? decodeURIComponent(m[1]) : ''
  }
  const tokenOk = (req, url) => {
    if (!token) return true
    const q = url.searchParams.get('t') || ''
    const h = String(req.headers['x-xhs-token'] || '')
    return [q, h, cookieToken(req)].some((v) => v && v === token)
  }
  const UNAUTHORIZED_PAGE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<body style="background:#0f1115;color:#e6e8ee;font:15px/1.6 system-ui;padding:32px">'
    + '<h2>需要访问令牌</h2><p style="color:#8b93a7">请在地址后面加上 <code>?t=你的令牌</code>，'
    + '令牌在电脑的 <code>%USERPROFILE%\\.dsh\\xhs-agent\\panel-token.txt</code>。</p></body>'

  const readBody = (req) => new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) reject(new Error('body too large')) })
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}) } catch (e) { reject(e) } })
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
        if (!isLocal(req)) {
          if (!tokenOk(req, url)) {
            res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
            res.end(UNAUTHORIZED_PAGE)
            return
          }
          // 带 ?t= 首次进来 → 写 Cookie 再跳转，之后地址栏就不带令牌了
          if (url.searchParams.get('t')) {
            res.writeHead(302, {
              location: '/',
              'set-cookie': `xhs_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
            })
            res.end()
            return
          }
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(readPage())
        return
      }

      // 所有 /api/*：非本机必须带令牌
      if (!isLocal(req) && !tokenOk(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' })

      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(res, 200, {
          status: await getStatus(),
          rules: readJson(rulesPath, {}),
          rulesPath,
          drafts: readDrafts(),
          local: isLocal(req),
        })
      }

      // 点「未登录」→ 拉起有头登录窗口（扫码 / 换号），关窗后宿主会自动重启 sidecar
      if (req.method === 'POST' && url.pathname === '/api/login/window') {
        if (!isLocal(req)) {
          return json(res, 403, { ok: false, blocked: 'local_only', error: '登录窗口只能在电脑上打开' })
        }
        return json(res, 200, await openLoginWindow())
      }
      // 话术库：读 / 存。改话术属于高风险（直接决定发出去的话），只允许本机
      if (req.method === 'GET' && url.pathname === '/api/scripts') {
        return json(res, 200, { ok: true, scripts: getScripts ? getScripts() : null, path: scriptsPath })
      }

      if (req.method === 'POST' && url.pathname === '/api/scripts') {
        if (!isLocal(req)) {
          return json(res, 403, { ok: false, blocked: 'local_only', error: '话术库只能在电脑上修改' })
        }
        const body = await readBody(req)
        const r = await saveScripts(body?.scripts ?? body)
        return json(res, r?.ok ? 200 : 400, r ?? { ok: false })
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

      // 打开笔记：用系统默认浏览器打开小红书原帖（附带 xsec_token 才能看）
      if (req.method === 'POST' && url.pathname === '/api/open-note') {
        if (!isLocal(req)) {
          return json(res, 403, { ok: false, blocked: 'local_only', error: '打开笔记只能在电脑上操作' })
        }
        const body = await readBody(req)
        const feedId = String(body?.feedId || '')
        if (!/^[0-9a-f]{24}$/i.test(feedId)) {
          return json(res, 400, { ok: false, error: 'feedId 不合法' })
        }
        const target = noteUrl(feedId, String(body?.xsecToken || ''))
        try {
          const p = spawn('cmd.exe', ['/c', 'start', '', target], { windowsHide: true, detached: true, stdio: 'ignore' })
          p.unref()
        } catch (e) {
          return json(res, 500, { ok: false, error: `打开失败：${e?.message ?? e}`, url: target })
        }
        return json(res, 200, { ok: true, url: target })
      }

      // 清空回复清单：只清 drafts.jsonl，不动已发送记录 / 去重记录 / 话术库
      if (req.method === 'POST' && url.pathname === '/api/drafts/clear') {
        if (!isLocal(req)) {
          return json(res, 403, { ok: false, blocked: 'local_only', error: '清空清单只能在电脑上做' })
        }
        const n = readDrafts().length
        try { writeFileSync(draftsPath, '') } catch (e) {
          return json(res, 500, { ok: false, error: String(e?.message ?? e) })
        }
        return json(res, 200, { ok: true, cleared: n })
      }

      // 运行控制：pause / resume / stop
      if (req.method === 'POST' && url.pathname === '/api/control') {
        const body = await readBody(req)
        return json(res, 200, await control(body?.action))
      }

      if (req.method === 'POST' && url.pathname === '/api/reply') {
        // 发送强门禁的第二道：只允许本机点「发送这条」，手机/远程一律拒绝
        if (!isLocal(req)) {
          return json(res, 403, { ok: false, blocked: 'local_only', error: '真实发送只能在电脑上确认' })
        }
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
