/**
 * dsh-xhs-comment-agent (ESM)
 *
 * DSH 宿主插件：托管本地 xiaohongshu-mcp 进程，直连它的 REST API，
 * 对外提供 xhs_login / xhs_search / xhs_comments / xhs_plan / xhs_reply / xhs_status。
 *
 * 字段已按 v2.7.0 实测校准：
 *   search  → data.feeds[] { id, xsecToken, noteCard:{ displayTitle, user:{nickname}, interactInfo:{likedCount} } }
 *   detail  → data.data.{ note, comments:{ list:[ { id, content, likeCount, userInfo:{userId,nickname}, subComments } ] } }
 *   filters → 必须是对象，不是数组（数组会 400 INVALID_REQUEST）
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startPanel } from './panel.js'
import { createRunner, STOP } from './run.js'

// 不 import 任何 @deepseek-ai/* ：本插件通过 profile 补丁以「绝对路径」加载，
// 那种加载方式下裸导入会从插件目录向上找 node_modules，必然解析失败。
// defineTool 本身只是给工具定义加类型/校验，注册表要的就是对象本身。
const defineTool = (def) => def

// 诊断：模块是否被 import、apply 是否被调用、有没有抛错。
const BOOT_LOG = join(homedir(), '.dsh', 'xhs-agent', 'boot.log')
const mark = (m) => {
  try { appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${m}\n`) } catch { /* ignore */ }
}
mark('module imported')

export const name = 'xhs-comment-agent'
// Cordis 依赖声明：没有它，apply 时 ctx.tools 还不存在，注册会直接抛错。
export const inject = ['tools']

const expand = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

const DEFAULT_RULES = {
  note_gate: { min_liked: 0 },
  comment_gate: {
    level: [1, 2],
    must_any: [],
    must_not: ['加微', '私信', 'VX', 'vx', '代理', '刷单', '代购'],
    max_len: 120,
    exclude_authors: [],
  },
  reply_policy: { max_per_note: 3, daily_quota: 20, hourly_quota: 5, min_interval_sec: 45, max_interval_sec: 180 },
  reply_style: { max_chars: 60 },
}

export function apply(ctx, config = {}) {
  mark('apply called')
  try {
    return applyInner(ctx, config)
  } catch (e) {
    mark('apply error: ' + (e && e.stack ? e.stack : String(e)))
    throw e
  }
}

function applyInner(ctx, config = {}) {
  const port = Number(config.port ?? 18060)
  const origin = `http://127.0.0.1:${port}`
  const apiBase = `${origin}/api/v1`
  const token = config.authToken
  const manageProcess = config.manageProcess !== false
  const binaryPath = expand(config.binaryPath ?? '')
  const dryRun = config.dryRun !== false
  const stateDir = expand(config.stateDir ?? '~/.dsh/xhs-agent')
  // xiaohongshu-mcp 从「当前工作目录」读 cookies.json —— 服务必须在这个目录里启动，
  // 否则登录态会丢。实测：换 cwd 启动后 is_logged_in 直接变 false。
  const workDir = expand(config.cwd ?? stateDir)
  const rulesPath = expand(config.rulesPath ?? join(stateDir, 'rules.json'))
  const statePath = join(stateDir, 'state.json')
  const draftsPath = join(stateDir, 'drafts.jsonl')
  const logPath = join(stateDir, 'agent.log')

  mkdirSync(stateDir, { recursive: true })
  try { appendFileSync(join(stateDir, 'agent.log'), `${new Date().toISOString()} apply() entered\n`) } catch { /* ignore */ }

  // 面板访问令牌：本机不需要，局域网 / Tailscale 进来的必须带；首次启动生成并落盘
  const panelToken = (() => {
    if (config.accessToken) return String(config.accessToken)
    const p = join(stateDir, 'panel-token.txt')
    try {
      const t = readFileSync(p, 'utf8').trim()
      if (t) return t
    } catch { /* 还没生成过 */ }
    const t = randomBytes(16).toString('hex')
    try { writeFileSync(p, t) } catch { /* 写不了就只用内存里这份 */ }
    return t
  })()

  // 规则每次调用现读：改 rules.json 立即生效，不需要重启 DSH。
  const getRules = () => {
    try {
      if (existsSync(rulesPath)) {
        const raw = JSON.parse(readFileSync(rulesPath, 'utf8'))
        return {
          note_gate: { ...DEFAULT_RULES.note_gate, ...(raw.note_gate ?? {}) },
          comment_gate: { ...DEFAULT_RULES.comment_gate, ...(raw.comment_gate ?? {}) },
          reply_policy: { ...DEFAULT_RULES.reply_policy, ...(raw.reply_policy ?? {}) },
          reply_style: { ...DEFAULT_RULES.reply_style, ...(raw.reply_style ?? {}) },
          keywords: raw.keywords ?? [],
          dry_run: typeof raw.dry_run === 'boolean' ? raw.dry_run : undefined,
          // 审核开关必须原样带回：漏了它 requireApproval() 读到的永远是 undefined，
          // 于是 `!== false` 恒为真，UI 上的开关就成了摆设。
          require_approval: typeof raw.require_approval === 'boolean' ? raw.require_approval : undefined,
          _error: null,
        }
      }
    } catch (e) {
      return { ...DEFAULT_RULES, keywords: [], _error: String(e?.message ?? e) }
    }
    return { ...DEFAULT_RULES, keywords: [], _error: null }
  }

  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { sent: {}, day: '', hour: '', dayCount: 0, hourCount: 0, lastSentAt: 0, incidents: [] }
  if (!state.sent) state.sent = {}
  if (!Array.isArray(state.incidents)) state.incidents = []
  if (!Array.isArray(state.skipped)) state.skipped = []
  // 人工批准凭证：只有 UI 的点击路径能签发，是一次性、5 分钟有效的票据。
  if (!state.approvals || typeof state.approvals !== 'object') state.approvals = {}

  // 面板上的「干跑」开关写在 rules.json 的 dry_run 上，优先级高于插件配置。
  const effDryRun = () => {
    const r = getRules()
    return typeof r.dry_run === 'boolean' ? r.dry_run : dryRun
  }

  // 审核硬门禁：默认开启。关掉它就是"agent 可以自己发"，只建议在可信环境这么做。
  const requireApproval = () => {
    const r = getRules()
    return r.require_approval !== false
  }

  const APPROVAL_TTL_MS = 5 * 60 * 1000
  const textHash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16)

  /** 由 UI 的点击路径调用：给 (commentId, 文案) 签发一张一次性票据。 */
  const mintApproval = (commentId, text) => {
    state.approvals[String(commentId)] = { at: Date.now(), h: textHash(text), used: false }
    persist()
    log(`approval minted for ${commentId}`)
  }

  /** 校验并消费票据；返回 null 表示放行，否则返回拒绝原因。 */
  const consumeApproval = (commentId, text) => {
    const a = state.approvals[String(commentId)]
    if (!a) return 'need_human_approval'
    if (a.used) return 'approval_already_used'
    if (Date.now() - a.at > APPROVAL_TTL_MS) { delete state.approvals[String(commentId)]; persist(); return 'approval_expired' }
    if (a.h !== textHash(text)) return 'text_changed_after_approval'
    a.used = true
    persist()
    return null
  }

  const persist = () => writeFileSync(statePath, JSON.stringify(state, null, 2))
  const log = (msg) => {
    try { appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`) } catch { /* ignore */ }
  }

  let child = null
  let starting = null

  const ping = async () => {
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1500) })
      return res.ok
    } catch { return false }
  }

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
        child.on('exit', (code) => log(`sidecar exited code=${code}`))
        for (let i = 0; i < 90; i++) {
          if (await ping()) return
          await new Promise((r) => setTimeout(r, 1000))
        }
        throw new Error('sidecar 90s 内未就绪')
      })().finally(() => { starting = null })
    }
    try { await starting; return { ok: true, started: true } } catch (e) {
      return { ok: false, started: true, reason: String(e?.message ?? e) }
    }
  }

  const api = async (path, body) => {
    const ready = await ensureService()
    if (!ready.ok) throw new Error(`xhs service unavailable: ${ready.reason}`)
    const res = await fetch(`${apiBase}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Number(config.requestTimeoutMs ?? 600000)),
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

  const refreshCounters = () => {
    const now = new Date()
    const day = now.toISOString().slice(0, 10)
    const hour = now.toISOString().slice(0, 13)
    if (state.day !== day) { state.day = day; state.dayCount = 0 }
    if (state.hour !== hour) { state.hour = hour; state.hourCount = 0 }
  }

  const hardStopped = () => (state.incidents || []).some((i) => String(i.reason).startsWith('HARD_STOP'))

  const guard = (commentId) => {
    refreshCounters()
    if (hardStopped()) return 'HARD_STOP: 已熔断，需人工处理后清空 state.incidents'
    if (state.sent[commentId]) return `already_sent@${state.sent[commentId].at}`
    if (state.dayCount >= (getRules().reply_policy.daily_quota ?? 20)) return 'daily_quota'
    if (state.hourCount >= (getRules().reply_policy.hourly_quota ?? 5)) return 'hourly_quota'
    const minGap = (getRules().reply_policy.min_interval_sec ?? 45) * 1000
    const wait = state.lastSentAt + minGap - Date.now()
    if (wait > 0) return `cooldown:${Math.ceil(wait / 1000)}s`
    return null
  }

  // 唯一的真实发送入口：面板「发送」和 xhs_reply 工具都走这里。
  // 三道闸：内容校验（禁用词/字数）→ 人工批准票据 → 平台调用。
  const doSend = async ({ feedId, xsecToken, commentId, text }) => {
    const rules = getRules()
    const rs = rules.reply_style ?? {}

    // 1) 禁用词：客户在 Excel 里填的，必须真的执行
    for (const w of rs.banned_words ?? []) {
      if (w && String(text).includes(w)) {
        return { ok: false, blocked: 'banned_word', word: w, hint: `回复里出现了禁用词「${w}」` }
      }
    }

    // 2) 字数
    const maxChars = rs.max_chars ?? 60
    if (String(text).length > maxChars) {
      return { ok: false, blocked: 'too_long', limit: maxChars, length: String(text).length }
    }

    // 3) 人工批准：票据只能由 UI 点击签发，agent 自己拿不到
    if (requireApproval()) {
      const deny = consumeApproval(commentId, text)
      if (deny) {
        return {
          ok: false,
          blocked: deny,
          next: '这条需要人在面板/右侧栏点「发送这条」；agent 无法自行批准',
        }
      }
    }

    try {
      await api('/feeds/comment/reply', {
        feed_id: feedId,
        xsec_token: xsecToken,
        comment_id: commentId,
        content: text,
      })
      const now = Date.now()
      state.sent[String(commentId)] = { at: new Date(now).toISOString(), noteId: feedId }
      state.dayCount += 1
      state.hourCount += 1
      state.lastSentAt = now
      persist()
      log(`sent reply to ${commentId}`)
      return { ok: true, repliedTo: commentId, quota: { day: state.dayCount, hour: state.hourCount } }
    } catch (e) {
      const msg = String(e?.message ?? e)
      if (/验证码|频繁|风控|滑块|未登录|login/i.test(msg)) {
        state.incidents.push({ at: new Date().toISOString(), reason: `HARD_STOP: ${msg}` })
        persist()
        log(`HARD_STOP ${msg}`)
        return { ok: false, halted: true, reason: msg, next: '停止自动发送，人工确认账号状态后再恢复' }
      }
      state.incidents.push({ at: new Date().toISOString(), reason: `send_failed: ${msg}` })
      persist()
      return { ok: false, error: msg }
    }
  }

  const matchText = (t, mustAny, mustNot) => {
    const s = t ?? ''
    if (mustAny?.length && !mustAny.some((k) => s.includes(k))) return false
    if (mustNot?.some((k) => s.includes(k))) return false
    return true
  }

  const flatten = (comments, level = 1, out = []) => {
    for (const c of comments ?? []) {
      out.push({ ...c, level })
      const subs = c.subComments ?? c.sub_comments ?? []
      if (subs.length) flatten(subs, level + 1, out)
    }
    return out
  }

  const objOut = { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] }

  ctx.tools.register(defineTool({
    name: 'xhs_status',
    description: '小红书 sidecar 健康、登录状态、今日配额、熔断与发送统计。',
    parameters: {},
    output: objOut,
    async execute() {
      const ready = await ensureService()
      const healthy = ready.ok
      let login = null
      if (healthy) {
        try { login = await api('/login/status') } catch (e) { login = { error: String(e?.message ?? e) } }
      }
      refreshCounters()
      const r = getRules()
      return {
        service: { origin, healthy, managed: manageProcess, pid: child?.pid ?? null, reason: ready.reason ?? null },
        login,
        dryRun: effDryRun(),
        requireApproval: requireApproval(),
        pendingApprovals: Object.keys(state.approvals || {}).length,
        rules: { path: rulesPath, error: r._error, comment_gate: r.comment_gate, reply_policy: r.reply_policy, reply_style: r.reply_style },
        quota: { dayCount: state.dayCount, hourCount: state.hourCount, ...r.reply_policy },
        sentTotal: Object.keys(state.sent).length,
        hardStopped: hardStopped(),
        incidents: (state.incidents || []).slice(-5),
        paths: { stateDir, rulesPath, draftsPath, logPath },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'xhs_login',
    description: '取登录二维码落盘为 PNG（返回路径，用 read_image 打开），可轮询等待登录完成。',
    parameters: { waitSeconds: { type: 'number', description: '轮询等待秒数，默认 0' } },
    output: objOut,
    async execute(args) {
      const status = await api('/login/status')
      if (status?.is_logged_in) return { loggedIn: true, user: status.username ?? null }
      const qr = await api('/login/qrcode')
      const b64 = qr?.qr_code ?? qr?.qrcode ?? qr?.image ?? qr?.img ?? ''
      const png = join(stateDir, 'login-qrcode.png')
      if (b64.includes('base64,')) writeFileSync(png, Buffer.from(b64.split('base64,')[1], 'base64'))
      else if (b64) writeFileSync(png, Buffer.from(b64, 'base64'))
      const wait = Number(args?.waitSeconds ?? 0)
      if (wait > 0) {
        for (let i = 0; i < Math.ceil(wait / 2); i++) {
          await new Promise((r) => setTimeout(r, 2000))
          const s = await api('/login/status')
          if (s?.is_logged_in) return { loggedIn: true, user: s.username ?? null, qrcode: png }
        }
        return { loggedIn: false, qrcode: png, timeoutSeconds: wait }
      }
      return { loggedIn: false, qrcode: png, hint: '用 read_image 打开二维码，手机小红书扫码' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'xhs_search',
    description: '按关键词搜索笔记，返回 feedId / xsecToken / 标题 / 点赞，并按 note_gate 预筛。',
    parameters: {
      keyword: { type: 'string', required: true, description: '关键词' },
      sortBy: { type: 'string', description: '综合|最新|最多点赞|最多评论|最多收藏' },
      noteType: { type: 'string', description: '不限|视频|图文' },
      publishTime: { type: 'string', description: '不限|一天内|一周内|半年内' },
      limit: { type: 'number', description: '最多返回篇数，默认 10' },
    },
    output: objOut,
    async execute(args) {
      const sd = getRules().search_defaults ?? {}
      const raw = await api('/feeds/search', {
        keyword: args.keyword,
        filters: {
          sort_by: args.sortBy ?? '综合',
          note_type: args.noteType ?? sd.note_type ?? '不限',
          publish_time: args.publishTime ?? sd.publish_time ?? '不限',
        },
      })
      const items = (raw?.feeds ?? []).slice(0, args.limit ?? 10)
      const g = getRules().note_gate
      const notes = items.filter((n) => {
        const liked = Number(n?.noteCard?.interactInfo?.likedCount ?? 0)
        if (liked < (g.min_liked ?? 0)) return false
        const title = String(n?.noteCard?.displayTitle ?? '')
        if (g.title_must_any?.length && !g.title_must_any.some((k) => title.includes(k))) return false
        if (g.title_must_not?.some((k) => title.includes(k))) return false
        return true
      }).map((n) => ({
        feedId: n?.id,
        xsecToken: n?.xsecToken,
        title: n?.noteCard?.displayTitle ?? '',
        author: n?.noteCard?.user?.nickname ?? '',
        liked: Number(n?.noteCard?.interactInfo?.likedCount ?? 0),
        noteType: n?.noteCard?.type ?? '',
      }))
      return { keyword: args.keyword, total: (raw?.feeds ?? []).length, kept: notes.length, notes }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'xhs_comments',
    description: '打开笔记详情，滚动加载并展开「展开N条回复」，返回一/二级评论候选项。耗时约 30-90 秒。',
    parameters: {
      feedId: { type: 'string', required: true, description: 'feed_id' },
      xsecToken: { type: 'string', required: true, description: 'xsec_token' },
      maxComments: { type: 'number', description: '最多加载一级评论数，默认 20' },
      clickMoreReplies: { type: 'boolean', description: '是否展开二级回复，默认 true' },
      replyLimit: { type: 'number', description: '回复数超过该值的跳过，默认 50（太大不好，太小会漏）' },
    },
    output: objOut,
    async execute(args) {
      const detail = await api('/feeds/detail', {
        feed_id: args.feedId,
        xsec_token: args.xsecToken,
        load_all_comments: true,
        comment_config: {
          click_more_replies: args.clickMoreReplies !== false,
          max_replies_threshold: args.replyLimit ?? 50,
          max_comment_items: args.maxComments ?? 20,
          scroll_speed: 'normal',
        },
      })
      const node = detail?.data ?? detail ?? {}
      const note = node.note ?? {}
      const rawList = node.comments?.list ?? []
      const all = flatten(Array.isArray(rawList) ? rawList : [])
      const gate = getRules().comment_gate
      const comments = all.filter((c) => {
        if (gate.level?.length && !gate.level.includes(c.level)) return false
        if (String(c.content ?? '').length > (gate.max_len ?? 500)) return false
        if (gate.exclude_authors?.includes(String(c.userInfo?.nickname ?? ''))) return false
        return matchText(String(c.content ?? ''), gate.must_any, gate.must_not)
      }).map((c) => ({
        commentId: String(c.id ?? ''),
        userId: String(c.userInfo?.userId ?? ''),
        user: c.userInfo?.nickname ?? '',
        content: c.content ?? '',
        level: c.level,
        liked: Number(c.likeCount ?? 0),
        subCommentCount: c.subCommentCount ?? 0,
      }))
      return {
        feedId: args.feedId,
        title: note.title ?? '',
        totalScanned: all.length,
        candidates: comments.length,
        comments,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'xhs_plan',
    description: '把候选评论 + 回复文案写成草稿（含证据），落盘 drafts.jsonl；不发送。',
    parameters: {
      feedId: { type: 'string', required: true, description: '笔记 id（仅用于记录）' },
      xsecToken: { type: 'string', description: 'xsec_token（面板发送需要，务必带上）' },
      candidates: { type: 'array', required: true, description: 'xhs_comments 返回的 comments' },
      replyTexts: { type: 'array', required: true, description: '与 candidates 一一对应的文案' },
    },
    output: objOut,
    async execute(args) {
      const rules = getRules()
      const max = rules.reply_policy.max_per_note ?? 3
      const banned = rules.reply_style.banned_words ?? []
      const approved = []
      const rejected = []
      const used = new Set()
      for (let i = 0; i < args.candidates.length; i++) {
        const c = args.candidates[i]
        const text = String(args.replyTexts?.[i] ?? '').trim()
        if (!text) { rejected.push({ commentId: c.commentId, why: 'no_reply_text' }); continue }
        if (state.sent[c.commentId]) { rejected.push({ commentId: c.commentId, why: 'already_sent' }); continue }
        if (used.has(c.userId)) { rejected.push({ commentId: c.commentId, why: 'dup_user' }); continue }
        if (approved.length >= max) { rejected.push({ commentId: c.commentId, why: 'max_per_note' }); continue }
        if (text.length > (rules.reply_style.max_chars ?? 60)) { rejected.push({ commentId: c.commentId, why: 'too_long' }); continue }
        const hit = banned.find((w) => w && text.includes(w))
        if (hit) { rejected.push({ commentId: c.commentId, why: 'banned_word', word: hit }); continue }
        used.add(c.userId)
        approved.push({ feedId: args.feedId, xsecToken: args.xsecToken ?? '', ...c, replyText: text, createdAt: new Date().toISOString(), dryRun: effDryRun() })
      }
      if (approved.length) appendFileSync(draftsPath, approved.map((d) => JSON.stringify(d)).join('\n') + '\n')
      return {
        approved: approved.length,
        rejected,
        drafts: approved,
        style: {
          tone: rules.reply_style.tone ?? '',
          max_chars: rules.reply_style.max_chars ?? 60,
          banned_words: banned,
          example_good: rules.reply_style.example_good ?? [],
          example_bad: rules.reply_style.example_bad ?? [],
        },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'xhs_reply',
    description:
      '回复指定评论（一级/二级）。干跑时只回显；非干跑时还需要「人工批准」——'
      + '票据只能由面板/右侧栏点「发送这条」签发，agent 自己无法批准，会返回 need_human_approval。'
      + '所以这个工具在关闭干跑后主要用来验证文案，真正发送请让用户去 UI 点。',
    parameters: {
      feedId: { type: 'string', required: true, description: 'feed_id' },
      xsecToken: { type: 'string', required: true, description: 'xsec_token' },
      commentId: { type: 'string', required: true, description: '目标评论 id' },
      text: { type: 'string', required: true, description: '回复文案' },
      confirm: { type: 'boolean', description: '确认位（仍需人工批准票据，单靠它为 true 发不出去）' },
    },
    output: objOut,
    async execute(args) {
      const block = guard(String(args.commentId))
      if (block) return { ok: false, blocked: block }
      const text = String(args.text ?? '').trim()
      if (!text) return { ok: false, blocked: 'empty_text' }
      if (effDryRun()) return { ok: true, dryRun: true, wouldReplyTo: args.commentId, text }
      if (args.confirm !== true) return { ok: false, blocked: 'need_confirm', text }
      return doSend({ feedId: args.feedId, xsecToken: args.xsecToken, commentId: args.commentId, text })
    },
  }))

  // --------------------------------------------------------------- runner

  const onDraft = (d) => {
    appendFileSync(draftsPath, JSON.stringify(d) + '\n')
  }

  const llmBridge = {
    stream: (opts) => {
      const llm = ctx.get && ctx.get('llm')
      if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有可用的 llm 服务')
      return llm.stream(opts)
    },
  }

  const runner = createRunner({
    api,
    getRules,
    llm: llmBridge,
    llmConfig: () => ({ provider: config.llmProvider, model: config.llmModel }),
    onDraft,
    send: (a) => doSend(a),
    log,
    state,
    persist,
    requireApproval,
    // 惰性转发：control / addUsage 在本作用域后面才定义，直接传会在初始化时撞 TDZ
    control: {
      reset: () => control.reset(),
      checkpoint: () => control.checkpoint(),
    },
    onUsage: (u) => addUsage(u),
  })

  let running = false

  // 运行控制：checkpoint() 在暂停时挂起、终止时抛 STOP，runner 在每次外部调用前调它。
  const control = {
    paused: false,
    stopped: false,
    waiters: [],
    reset() { this.paused = false; this.stopped = false; this.waiters = [] },
    pause() {
      this.paused = true
      if (state.job) state.job = { ...state.job, status: 'paused' }
      persist()
    },
    resume() {
      this.paused = false
      if (state.job) state.job = { ...state.job, status: 'running' }
      const w = this.waiters.splice(0)
      w.forEach((fn) => fn())
      persist()
    },
    stop() {
      this.stopped = true
      if (state.job) state.job = { ...state.job, status: 'stopping' }
      const w = this.waiters.splice(0)
      w.forEach((fn) => fn())
      persist()
    },
    async checkpoint() {
      if (this.stopped) throw STOP
      while (this.paused) {
        await new Promise((r) => this.waiters.push(r))
        if (this.stopped) throw STOP
      }
      if (this.stopped) throw STOP
    },
  }

  // token 用量：llm 流的 { type:'usage' } chunk 自带真实 inputTokens/outputTokens
  const addUsage = (u) => {
    const input = Number(u?.inputTokens ?? 0)
    const output = Number(u?.outputTokens ?? 0)
    const total = Number(u?.totalTokens ?? (input + output))
    if (!state.usage || typeof state.usage !== 'object') state.usage = { input: 0, output: 0, total: 0, calls: 0 }
    state.usage.input += input
    state.usage.output += output
    state.usage.total += total
    state.usage.calls += 1
    if (state.job) {
      const t = state.job.tokens ?? { input: 0, output: 0, total: 0, calls: 0 }
      state.job = {
        ...state.job,
        tokens: { input: t.input + input, output: t.output + output, total: t.total + total, calls: t.calls + 1 },
      }
    }
    persist()
  }

  const startRun = (body) => {
    if (running) return { ok: false, busy: true, error: '上一轮还在跑，先暂停或终止' }
    running = true
    control.reset()
    const mode = body?.mode === 'loop' ? 'loop' : 'once'
    const p = runner.run({ mode })
    p.catch((e) => {
      state.job = { ...(state.job ?? {}), status: 'error', phase: 'error', errors: [String(e?.message ?? e)] }
      persist()
    }).finally(() => { running = false })
    return { ok: true, started: true, mode }
  }

  const controlRun = (action) => {
    if (action === 'pause') {
      if (!running) return { ok: false, error: '当前没有在跑' }
      control.pause()
      return { ok: true, status: 'paused' }
    }
    if (action === 'resume') {
      if (!running) return { ok: false, error: '当前没有在跑' }
      control.resume()
      return { ok: true, status: 'running' }
    }
    if (action === 'stop') {
      if (!running) return { ok: false, error: '当前没有在跑' }
      control.stop()
      return { ok: true, status: 'stopping' }
    }
    return { ok: false, error: `未知操作：${action}` }
  }

  // --------------------------------------------------------------- panel

  const panel = (() => {
    try {
      return startPanel({
        port: Number(config.panelPort ?? 18765),
        host: config.panelHost ?? '127.0.0.1',
        token: panelToken,
        rulesPath,
        statePath,
        draftsPath,
        getStatus: async () => {
          const ready = await ensureService()
          let login = null
          if (ready.ok) {
            try { login = await api('/login/status') } catch (e) { login = { error: String(e?.message ?? e) } }
          }
          refreshCounters()
          const r = getRules()
          return {
            healthy: ready.ok,
            reason: ready.reason ?? null,
            login,
            dryRun: effDryRun(),
            requireApproval: requireApproval(),
            job: state.job ?? null,
            running,
            paused: control.paused,
            usage: state.usage ?? { input: 0, output: 0, total: 0, calls: 0 },
            quota: { dayCount: state.dayCount, hourCount: state.hourCount, ...r.reply_policy },
            sentTotal: Object.keys(state.sent).length,
            hardStopped: hardStopped(),
          }
        },
        run: async (body) => startRun(body),
        control: async (action) => controlRun(action),
        approve: async (d) => {
          const block = guard(String(d.commentId))
          if (block) return { ok: false, blocked: block }
          if (!d.text) return { ok: false, blocked: 'empty_text' }
          if (!d.xsecToken) return { ok: false, blocked: 'missing_xsec_token' }
          if (effDryRun()) return { ok: false, blocked: 'dry_run_on' }
          // 走到这里 = 人在 UI 上点了「发送这条」，签发一次性票据
          mintApproval(d.commentId, d.text)
          return doSend({ feedId: d.feedId, xsecToken: d.xsecToken, commentId: d.commentId, text: d.text })
        },
        skip: async (commentId) => {
          if (!Array.isArray(state.skipped)) state.skipped = []
          state.skipped.push({ commentId, at: new Date().toISOString() })
          persist()
          return { ok: true }
        },
      })
    } catch (e) {
      log(`panel start failed: ${e?.message ?? e}`)
      return null
    }
  })()
  if (panel) log(`panel listening: ${panel.url}`)

  ctx.effect(() => () => {
    if (child && !child.killed) {
      log('dispose: killing sidecar')
      try { child.kill() } catch { /* ignore */ }
      child = null
    }
    try { panel?.close() } catch { /* ignore */ }
  }, 'xhs-comment-agent.sidecar')

  log('plugin applied')
}
