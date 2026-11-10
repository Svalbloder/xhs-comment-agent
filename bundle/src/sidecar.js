/**
 * sidecar 管理：进程生命周期、健康检查、REST 调用、登录态与登录窗口。
 *
 * 从 index.js 里拆出来，职责单一：
 *   - ensureService()  确保 xiaohongshu-mcp 在跑（必要时拉起，90 秒超时）
 *   - api()            带鉴权与超时的 REST 封装
 *   - readLogin()      登录态（30 秒缓存，失败保留旧值，避免 UI 闪烁）
 *   - openLoginWindow() 拉起有头登录窗口，关窗后自动重启 sidecar 载入新 cookie
 *
 * 不依赖任何 @deepseek-ai/* 模块，纯 Node。
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const expand = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

export function createSidecar(opts = {}) {
  const { config = {}, log = () => {}, workDir, port = 18060, token = '' } = opts
  const origin = `http://127.0.0.1:${port}`
  const apiBase = `${origin}/api/v1`
  const manageProcess = config.manageProcess !== false
  const binaryPath = expand(config.binaryPath ?? '')
  const loginExe = expand(config.loginBinaryPath ?? join(homedir(), '.dsh', 'runtimes', 'xiaohongshu-login.exe'))
  const cookiesFile = join(workDir, 'cookies.json')

  let child = null
  let starting = null
  let loginProc = null

  // 健康检查缓存：抓评论时 sidecar 在驱动浏览器，/health 可能几秒不应答；
  // 成功结果缓存 2 秒，失败但进程还活着且 90 秒内成功过就报"忙"而不是"离线"。
  let healthCache = { at: 0, ok: false, lastOkAt: 0 }

  // 登录态缓存：每次查登录都要动一次浏览器页面，被 2.5s/4s 的轮询反复触发会互相踩。
  const LOGIN_TTL_MS = 30000
  let loginCache = { at: 0, value: null, error: null }

  const cookieMtime = () => { try { return statSync(cookiesFile).mtimeMs } catch { return 0 } }
  const alive = () => !!(child && !child.killed && child.exitCode === null)
  const loginOpen = () => !!(loginProc && loginProc.exitCode === null)
  const invalidateLogin = () => { loginCache = { at: 0, value: null, error: null } }

  const ping = async (force = false) => {
    if (!force && healthCache.ok && (Date.now() - healthCache.at) < 2000) return true
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) })
      healthCache = { at: Date.now(), ok: res.ok, lastOkAt: res.ok ? Date.now() : healthCache.lastOkAt }
      return res.ok
    } catch {
      healthCache = { at: Date.now(), ok: false, lastOkAt: healthCache.lastOkAt }
      return false
    }
  }

  const busy = () => alive() && (Date.now() - healthCache.lastOkAt) < 90000

  const ensureService = async () => {
    if (await ping()) return { ok: true, started: false }
    if (!manageProcess) return { ok: false, started: false, reason: `服务未在 ${origin} 运行（manageProcess=false）` }
    if (!binaryPath || !existsSync(binaryPath)) {
      return { ok: false, started: false, reason: `binaryPath 不存在：${binaryPath || '(未配置)'}` }
    }
    if (!starting) {
      starting = (async () => {
        log(`spawn ${binaryPath} -port :${port}`)
        child = spawn(binaryPath, ['-port', `:${port}`, ...(config.headless === false ? ['-headless=false'] : [])], {
          windowsHide: true,
          cwd: workDir,
          stdio: 'ignore',
          env: { ...process.env, ...(token ? { AUTH_TOKEN: token } : {}) },
        })
        child.on('exit', (code) => { invalidateLogin(); log(`sidecar exited code=${code}`) })
        for (let i = 0; i < 90; i += 1) {
          if (await ping()) return
          await new Promise((r) => setTimeout(r, 1000))
        }
        throw new Error('sidecar 90s 内未就绪')
      })().finally(() => { starting = null })
    }
    try {
      await starting
      return { ok: true, started: true }
    } catch (e) {
      return { ok: false, started: true, reason: String(e?.message ?? e) }
    }
  }

  // opts.timeoutMs：登录态检查这类"卡住就卡住"的调用要短超时，不能把整个 /api/state 拖死
  const api = async (path, body, opts = {}) => {
    const ready = await ensureService()
    if (!ready.ok) throw new Error(`xhs service unavailable: ${ready.reason}`)
    const res = await fetch(`${apiBase}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Number(opts.timeoutMs ?? config.requestTimeoutMs ?? 600000)),
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 300)}`)
    if (json && (json.success === false || (typeof json.code === 'number' && json.code !== 0))) {
      throw new Error(`${path} 返回失败: ${json.msg ?? json.message ?? text.slice(0, 300)}`)
    }
    return json?.data ?? json
  }

  // 登录态「读缓存 + 后台刷新」：
  // 查登录要驱动一次浏览器页面，空闲唤醒时能超过 8 秒。如果同步 await，/api/state 会被拖住，
  // 前端轮询堆积、偶发超时又显示未登录。所以这里永远立刻返回手里的值，刷新在后台做。
  let loginRefreshing = false

  const kickLoginRefresh = () => {
    if (loginRefreshing) return
    loginRefreshing = true
    api('/login/status', undefined, { timeoutMs: 15000 })
      .then((v) => { loginCache = { at: Date.now(), value: v, error: null } })
      .catch((e) => { loginCache = { ...loginCache, error: String(e?.message ?? e) } })
      .finally(() => { loginRefreshing = false })
  }

  const readLogin = async () => {
    const fresh = loginCache.value && (Date.now() - loginCache.at) < LOGIN_TTL_MS
    if (!fresh) kickLoginRefresh()
    if (loginCache.value) return loginCache.value
    return loginCache.error
      ? { error: loginCache.error, stale: true }
      : { pending: true }
  }

  // 登录窗口：直接拉起 xiaohongshu-login.exe（有头 Chromium），扫码 / 换号都在里面完成
  const openLoginWindow = () => {
    if (loginOpen()) {
      return { ok: true, already: true, hint: '登录窗口已经开着，去那个窗口操作' }
    }
    if (!existsSync(loginExe)) {
      return { ok: false, error: `找不到登录程序：${loginExe}（重跑 deploy\\install.ps1 会补下载）` }
    }
    const before = cookieMtime()
    try {
      loginProc = spawn(loginExe, [], { cwd: workDir, stdio: 'ignore', windowsHide: false })
    } catch (e) {
      return { ok: false, error: `启动登录窗口失败：${e?.message ?? e}` }
    }
    log(`login window opened: ${loginExe}`)
    loginProc.on('exit', async (code) => {
      loginProc = null
      const changed = cookieMtime() > before
      invalidateLogin()
      log(`login window closed code=${code} cookiesChanged=${changed}`)
      // 关窗后重启 sidecar，让它重新读 cookies.json（否则仍是旧会话）
      try {
        if (child && !child.killed) child.kill()
      } catch { /* ignore */ }
      child = null
      starting = null
      if (changed) {
        try { await ensureService() } catch { /* 下次调用还会重试 */ }
      }
    })
    return { ok: true, started: true, exe: loginExe }
  }

  const dispose = () => {
    if (child && !child.killed) {
      try { child.kill() } catch { /* ignore */ }
    }
    child = null
    starting = null
  }

  return {
    origin,
    ensureService,
    api,
    readLogin,
    invalidateLogin,
    openLoginWindow,
    busy,
    alive,
    loginOpen,
    loginAvailable: () => existsSync(loginExe),
    pid: () => (child ? child.pid : null),
    dispose,
  }
}
