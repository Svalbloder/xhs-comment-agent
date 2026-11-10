/**
 * DSH 客户端半侧：右侧栏「小红书评论」标签页。
 *
 * 手写 ESM/IIFE，不经过任何打包：宿主用 window.__ModuleLoader__.load 注入，
 * factory 里拿到的 require 只解析宿主模块表里的东西（react 等）。
 *
 * 数据全部走宿主面板的 HTTP API（127.0.0.1:18765），因此需要在 panel.js 里开 CORS。
 */
;(function () {
  const PANEL_ORIGIN = 'http://127.0.0.1:18765'
  const TAB_ID = 'xhs-comment-panel'
  const TAB_KIND = 'xhs-comment'

  const CSS = `
  .xhs-pane{display:flex;flex-direction:column;gap:10px;padding:12px;font-size:13px;color:inherit;height:100%;overflow:auto}
  .xhs-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .xhs-sp{flex:1}
  .xhs-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;border:1px solid currentColor;opacity:.75;font-size:12px}
  .xhs-chip.ok{color:#2fbf71;border-color:#2fbf71;opacity:1}
  .xhs-chip.bad{color:#ff4d67;border-color:#ff4d67;opacity:1}
  .xhs-chip-btn{cursor:pointer;background:transparent;font:inherit}
  .xhs-link{display:block;width:100%;text-align:left;background:transparent;border:0;color:#7fb3d5;font:inherit;font-size:12px;padding:2px 0 4px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .xhs-link:hover{text-decoration:underline}
  .xhs-card{border:1px solid rgba(127,127,127,.25);border-radius:10px;padding:10px}
  .xhs-label{display:block;font-size:11px;opacity:.65;margin:8px 0 4px}
  .xhs-input,.xhs-area{width:100%;box-sizing:border-box;background:transparent;color:inherit;border:1px solid rgba(127,127,127,.35);border-radius:8px;padding:6px 8px;font:inherit}
  .xhs-area{min-height:58px;resize:vertical}
  .xhs-btn{background:transparent;color:inherit;border:1px solid rgba(127,127,127,.45);border-radius:8px;padding:5px 10px;font:inherit;cursor:pointer}
  .xhs-btn.primary{border-color:#ff2e4d;color:#ff2e4d}
  .xhs-btn:disabled{opacity:.4;cursor:not-allowed}
  .xhs-draft{border-top:1px solid rgba(127,127,127,.2);padding:8px 0}
  .xhs-draft:first-child{border-top:0}
  .xhs-quote{border-left:2px solid rgba(127,127,127,.35);padding:4px 8px;margin:4px 0;opacity:.9;white-space:pre-wrap}
  .xhs-mut{opacity:.6;font-size:11px}
  .xhs-tabs{display:flex;gap:6px}
  .xhs-tab{padding:4px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent}
  .xhs-tab.on{border-color:rgba(127,127,127,.45);background:rgba(127,127,127,.12)}
  .xhs-warn{color:#e6a23c;font-size:11px}
  .xhs-tags{display:flex;flex-wrap:wrap;gap:6px;align-items:center;border:1px solid rgba(127,127,127,.35);border-radius:8px;padding:6px;min-height:38px;box-sizing:border-box}
  .xhs-tag{display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 8px;border-radius:999px;background:rgba(127,127,127,.16);font-size:12px;max-width:100%}
  .xhs-tag-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .xhs-tag-x{border:0;background:transparent;color:inherit;opacity:.6;cursor:pointer;font-size:14px;line-height:1;padding:0 3px}
  .xhs-tag-x:hover{opacity:1;color:#ff4d67}
  .xhs-tag-input{flex:1;min-width:100px;border:0;background:transparent;color:inherit;font:inherit;outline:0;padding:2px}
  `

  function injectCss() {
    if (typeof document === 'undefined') return () => {}
    const id = 'xhs-comment-pane-css'
    let tag = document.getElementById(id)
    if (!tag) {
      tag = document.createElement('style')
      tag.id = id
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    return () => { /* 保留样式，避免切换标签时闪烁 */ }
  }

  async function api(path, init) {
    const res = await fetch(PANEL_ORIGIN + path, init)
    const text = await res.text()
    try { return JSON.parse(text) } catch { return { ok: false, error: text.slice(0, 200) } }
  }

  function makePanel(React) {
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React
  const PHASE_LABEL = { searching: '搜索中', collecting: '抓评论', sending: '发送中', done: '完成', error: '出错' }
  const fmt = (n) => Number(n || 0).toLocaleString('zh-CN')
  function statusLabel(job) {
    if (!job) return '空闲'
    const s = job.status
    if (s === 'running') return '运行中'
    if (s === 'paused') return '已暂停'
    if (s === 'stopping') return '正在终止…'
    if (s === 'stopped') return '已停止'
    if (s === 'done') return '已完成'
    if (s === 'error') return '出错'
    return '空闲'
  }
  function statusTone(job) {
    if (!job) return ''
    if (job.status === 'running' || job.status === 'done') return 'ok'
    if (job.status === 'error') return 'bad'
    return ''
  }
  function describeNow(job) {
    const c = job && job.current
    if (!c) {
      if (job && job.status === 'done') return '这一轮已结束'
      if (job && job.status === 'stopped') return '已终止'
      return '还没跑过'
    }
    if (c.action === 'searching') return '正在搜索「' + (c.keyword || '…') + '」'
    if (c.action === 'comments') return '抓评论：' + (c.noteTitle || '')
    if (c.action === 'generating') return '生成回复：@' + (c.commentUser || '') + ' 「' + (c.commentText || '') + '」'
    if (c.action === 'drafted') return '草稿已生成：' + (c.replyText || '')
    if (c.action === 'waiting') return '等下一轮（约 ' + (c.seconds || 0) + ' 秒）'
    return ''
  }
  function describeProgress(job) {
    if (!job || !job.status) return ''
    return '第 ' + (job.cycles || 0) + ' 轮 · 笔记 ' + (job.notesDone || 0) + '/' + (job.notesTotal || 0) +
      ' · 候选 ' + (job.candidates || 0) + ' · 草稿 ' + (job.drafted || 0) + ' · 已发 ' + (job.sent || 0) +
      ((job.errors && job.errors.length) ? (' · 错误 ' + job.errors.length) : '')
  }
  // 同一波（同一次运行 + 同一轮）生成的草稿用同一颜色，低饱和、深色底上不刺眼
  const WAVE_COLORS = ['#7fb3d5', '#8fd3c8', '#a3c9a5', '#e6c88a', '#b8a7e0', '#e0a7b4', '#8fc1e3', '#c2b280']

  function hexToRgba(hex, a) {
    const h = String(hex).replace('#', '')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'
  }

  function fmtTime(iso) {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    const p = (n) => String(n).padStart(2, '0')
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  // 话术池自动撑高，最多 720px
  function autoGrow(el) {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(720, el.scrollHeight + 2) + 'px'
  }

  function decorateWaves(list) {
    let lastKey = null
    let waveIdx = -1
    return (list || []).map((d) => {
      const key = (d.jobId || '') + '#' + (d.cycle == null ? '' : d.cycle) + '#' + String(d.createdAt || '').slice(0, 16)
      if (key !== lastKey) { lastKey = key; waveIdx += 1 }
      return { ...d, __color: WAVE_COLORS[waveIdx % WAVE_COLORS.length], __wave: waveIdx }
    })
  }

  function describeTokens(job, st) {
    const t = (job && job.tokens) || { input: 0, output: 0, total: 0, calls: 0 }
    const u = (st && st.usage) || { total: 0 }
    return '本轮 token ' + fmt(t.total) + '（入 ' + fmt(t.input) + ' / 出 ' + fmt(t.output) + ' · ' +
      (t.calls || 0) + ' 次调用） ｜ 累计 ' + fmt(u.total)
  }

  // 标签式输入：回车或点「添加」生成一个标签，点 × 删除；Backspace 删最后一个。
  function ChipField(props) {
    const { value, placeholder, onChange } = props
    const list = Array.isArray(value) ? value : []
    const [text, setText] = useState('')
    const add = () => {
      const v = String(text || '').trim()
      if (!v) return
      if (!list.includes(v)) onChange(list.concat([v]))
      setText('')
    }
    return h('div', { className: 'xhs-tags' },
      list.map((v, i) => h('span', { className: 'xhs-tag', key: v + '#' + i },
        h('span', { className: 'xhs-tag-t' }, v),
        h('button', {
          className: 'xhs-tag-x', type: 'button', title: '删除',
          onClick: () => onChange(list.filter((_, k) => k !== i)),
        }, '×'))),
      h('input', {
        className: 'xhs-tag-input',
        value: text,
        placeholder: list.length ? '继续添加…' : placeholder,
        onChange: (e) => setText(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); add() }
          if (e.key === 'Backspace' && !text && list.length) onChange(list.slice(0, -1))
        },
      }),
      h('button', { className: 'xhs-btn', type: 'button', onClick: add, disabled: !String(text || '').trim() }, '添加'),
    )
  }

    return function XhsPanel() {
      const [state, setState] = useState(null)
      const [tab, setTab] = useState('main')
      const [form, setForm] = useState(null)
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState(false)
      const [scripts, setScripts] = useState(null)
      const [scriptsMsg, setScriptsMsg] = useState('')
      // 刚改过开关的时间戳：3 秒内不拿服务端值覆盖，避免"刚点就被回滚"的抖动
      const lastEditRef = useRef(0)

      const load = useCallback(async () => {
        const s = await api('/api/state')
        if (!s || !s.status) return
        setState(s)
        const srvApproval = s.status.requireApproval !== false
        const srvDry = !!(s.rules.dry_run ?? s.status.dryRun)
        setForm((prev) => {
          if (!prev) {
            return {
              keywords: (s.rules.keywords || []).slice(),
              require_approval: srvApproval,
              must_any: (((s.rules.comment_gate || {}).must_any) || []).slice(),
              must_not: (((s.rules.comment_gate || {}).must_not) || []).slice(),
              max_len: (s.rules.comment_gate || {}).max_len ?? 120,
              max_per_note: (s.rules.reply_policy || {}).max_per_note ?? 2,
              hourly_quota: (s.rules.reply_policy || {}).hourly_quota ?? 5,
              daily_quota: (s.rules.reply_policy || {}).daily_quota ?? 20,
              min_interval_sec: (s.rules.reply_policy || {}).min_interval_sec ?? 45,
              cycle_interval_sec: (s.rules.reply_policy || {}).cycle_interval_sec ?? 60,
              max_notes_per_cycle: (s.rules.reply_policy || {}).max_notes_per_cycle ?? 6,
              max_chars: (s.rules.reply_style || {}).max_chars ?? 60,
              banned_words: (((s.rules.reply_style || {}).banned_words) || []).slice(),
              dry_run: srvDry,
            }
          }
          // 两个开关以服务端为准（面板 / 别的窗口改了也要同步过来），刚点过的除外
          if (Date.now() - lastEditRef.current < 3000) return prev
          if (prev.require_approval === srvApproval && prev.dry_run === srvDry) return prev
          return { ...prev, require_approval: srvApproval, dry_run: srvDry }
        })
      }, [])

      useEffect(() => { load() }, [load])
      useEffect(() => { const t = setInterval(load, 4000); return () => clearInterval(t) }, [load])

      const loadScripts = useCallback(async () => {
        const r = await api('/api/scripts')
        if (r && r.ok && r.scripts) setScripts(r.scripts)
        else setScriptsMsg('话术库加载失败')
      }, [])

      useEffect(() => {
        if (tab === 'scripts' && !scripts) loadScripts()
      }, [tab, scripts, loadScripts])

      const patchScene = (idx, patch) => {
        setScripts((prev) => {
          if (!prev) return prev
          const scenes = prev.scenes.map((s, i) => (i === idx ? { ...s, ...patch } : s))
          return { ...prev, scenes }
        })
      }

      const saveScripts = async () => {
        if (!scripts) return
        setBusy(true)
        const r = await api('/api/scripts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(scripts),
        })
        setBusy(false)
        if (r && r.ok) {
          setScripts(r.scripts)
          setScriptsMsg('已保存' + ((r.warnings && r.warnings.length) ? ('（' + r.warnings.length + ' 条提醒）') : ''))
        } else {
          setScriptsMsg('保存失败：' + ((r && ((r.errors && r.errors[0]) || r.error)) || ''))
        }
        setTimeout(() => setScriptsMsg(''), 4000)
      }

      const save = async (override) => {
        const f = override || form
        setBusy(true)
        const r = await api('/api/rules', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            keywords: f.keywords,
            require_approval: !!f.require_approval,
            comment_gate: { level: [1, 2], must_any: f.must_any, must_not: f.must_not, max_len: +f.max_len || 120 },
            reply_policy: { max_per_note: +f.max_per_note || 2, hourly_quota: +f.hourly_quota || 5, daily_quota: +f.daily_quota || 20, min_interval_sec: +f.min_interval_sec || 45, cycle_interval_sec: +f.cycle_interval_sec || 60, max_notes_per_cycle: +f.max_notes_per_cycle || 6 },
            reply_style: { max_chars: +f.max_chars || 60, banned_words: f.banned_words },
            dry_run: !!f.dry_run,
          }),
        })
        setBusy(false)
        setMsg(r && r.ok ? '设置已保存' : '保存失败：' + (r && r.error ? r.error : ''))
        setTimeout(() => setMsg(''), 2500)
      }

      const toggleSetting = (key, value) => {
        lastEditRef.current = Date.now()
        const next = { ...form, [key]: value }
        setForm(next)
        save(next)
      }

      const openLogin = async () => {
        const r = await api('/api/login/window', { method: 'POST' })
        setMsg(r && r.ok
          ? (r.already ? '登录窗口已经开着，去那个窗口操作' : '已打开登录窗口：扫码后关掉窗口即可')
          : ('打开失败：' + ((r && (r.error || r.blocked)) || '')))
        setTimeout(() => setMsg(''), 6000)
      }

      const runNow = async (mode) => {
        const r = await api('/api/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode }),
        })
        if (!r || !r.ok) {
          setMsg(r && r.busy ? '还在跑，先暂停或终止' : ('启动失败：' + ((r && r.error) || '')))
          setTimeout(() => setMsg(''), 3000)
          return
        }
        setMsg(mode === 'loop' ? '已开始持续运行（点「终止」才会停）' : '已开始跑一轮')
        setTimeout(() => setMsg(''), 3000)
        load()
      }

      const ctrl = async (action) => {
        const r = await api('/api/control', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        if (!r || !r.ok) {
          setMsg((r && (r.error || r.blocked)) || '操作失败')
          setTimeout(() => setMsg(''), 3000)
          return
        }
        setMsg(action === 'pause' ? '已暂停' : action === 'resume' ? '已继续' : '正在终止…')
        setTimeout(() => setMsg(''), 3000)
        load()
      }

      const send = async (d, text) => {
        if (!text.trim()) { setMsg('文案不能为空'); return }
        if (!window.confirm('确认发送到这条评论？\n\n' + String(d.content).slice(0, 60) + '\n\n回复：' + text)) return
        setBusy(true)
        const r = await api('/api/reply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ commentId: d.commentId, feedId: d.feedId, xsecToken: d.xsecToken, text }),
        })
        setBusy(false)
        setMsg(r && r.ok ? '已发送' : '失败：' + (r && (r.blocked || r.error || r.reason) ? (r.blocked || r.error || r.reason) : ''))
        setTimeout(() => setMsg(''), 3000)
        load()
      }

      const skip = async (d) => {
        await api('/api/skip', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ commentId: d.commentId }),
        })
        load()
      }

      const clearDrafts = async () => {
        if (!window.confirm('清空整个回复清单？\n\n只删草稿记录，不影响已发送记录、去重记录和话术库。')) return
        setBusy(true)
        const r = await api('/api/drafts/clear', { method: 'POST' })
        setBusy(false)
        if (r && r.ok) {
          setMsg('已清空 ' + (r.cleared || 0) + ' 条草稿')
          load()
        } else {
          setMsg('清空失败：' + ((r && (r.error || r.blocked)) || ''))
        }
        setTimeout(() => setMsg(''), 3000)
      }

      const openNote = async (d) => {
        const r = await api('/api/open-note', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ feedId: d.feedId, xsecToken: d.xsecToken }),
        })
        if (!r || !r.ok) {
          setMsg('打开笔记失败：' + ((r && (r.error || r.blocked)) || ''))
          setTimeout(() => setMsg(''), 3000)
        }
      }

      if (!state || !form) return h('div', { className: 'xhs-pane' }, h('div', { className: 'xhs-mut' }, '连接面板中…（首次启动需要几秒）'))

      const st = state.status
      const logged = st.login && st.login.is_logged_in
      const drafts = decorateWaves(state.drafts || [])

      return h('div', { className: 'xhs-pane' },
        h('div', { className: 'xhs-row' },
          st.healthy
            ? h('span', { className: 'xhs-chip ok' }, '服务在线')
            : (st.busy
              ? h('span', { className: 'xhs-chip', style: { color: '#e6a23c', borderColor: '#e6a23c' }, title: 'sidecar 正在抓取，暂时没空应答健康检查' }, '服务忙')
              : h('span', { className: 'xhs-chip bad' }, '服务离线')),
          logged
            ? h('span', {
              className: 'xhs-chip ok',
              title: st.login.stale ? '上次检查失败，显示缓存结果' : '实时检查',
            }, '已登录 · ' + (st.login.username || '') + (st.login.stale ? '（缓存）' : ''))
            : ((!st.login || st.login.pending)
              ? h('span', { className: 'xhs-chip' }, '登录状态检查中…')
              : h('button', {
                className: 'xhs-chip bad xhs-chip-btn',
                title: '打开小红书登录窗口，扫码或换账号',
                onClick: openLogin,
              }, '未登录 · 点这里扫码')),
          h('span', { className: 'xhs-chip' }, '今日 ' + st.quota.dayCount + '/' + st.quota.daily_quota),
          h('span', { className: 'xhs-chip' }, '本小时 ' + st.quota.hourCount + '/' + st.quota.hourly_quota),
        ),
        msg ? h('div', { className: 'xhs-warn' }, msg) : null,

        h('div', { className: 'xhs-tabs' },
          h('div', { className: 'xhs-tab ' + (tab === 'main' ? 'on' : ''), onClick: () => setTab('main') }, '主控'),
          h('div', { className: 'xhs-tab ' + (tab === 'drafts' ? 'on' : ''), onClick: () => setTab('drafts') },
            (st.requireApproval === false ? '回复记录' : '回复清单') + ' (' + drafts.length + ')'),
          h('div', { className: 'xhs-tab ' + (tab === 'scripts' ? 'on' : ''), onClick: () => setTab('scripts') }, '话术库'),
          h('div', { className: 'xhs-tab ' + (tab === 'rules' ? 'on' : ''), onClick: () => setTab('rules') }, '规则'),
        ),

        tab === 'main' ? h('div', { className: 'xhs-card' },
          h('div', { className: 'xhs-row' },
            h('span', { className: 'xhs-chip ' + statusTone(st.job) }, statusLabel(st.job)),
            h('div', { className: 'xhs-sp' }),
            h('span', { className: 'xhs-mut' }, '第 ' + ((st.job && st.job.cycles) || 0) + ' 轮'),
          ),
          h('div', { className: 'xhs-mut', style: { marginTop: 8 } }, describeNow(st.job)),
          h('div', { className: 'xhs-mut', style: { marginTop: 2 } }, describeProgress(st.job)),
          h('div', { className: 'xhs-mut', style: { marginTop: 2 } }, describeTokens(st.job, st)),
          h('div', { className: 'xhs-row', style: { marginTop: 12 } },
            h('button', { className: 'xhs-btn primary', disabled: st.running, onClick: () => runNow('loop') }, '开始'),
            h('button', { className: 'xhs-btn', disabled: st.running, onClick: () => runNow('once') }, '跑一轮'),
          ),
          h('div', { className: 'xhs-row', style: { marginTop: 6 } },
            h('button', { className: 'xhs-btn', disabled: !st.running || st.paused, onClick: () => ctrl('pause') }, '暂停'),
            h('button', { className: 'xhs-btn', disabled: !st.paused, onClick: () => ctrl('resume') }, '继续'),
            h('button', { className: 'xhs-btn', disabled: !st.running, onClick: () => ctrl('stop') }, '终止'),
          ),
          h('div', { className: 'xhs-mut', style: { marginTop: 8 } }, '「开始」会一轮接一轮持续跑，直到点「终止」。'),
          st.requireApproval === false
            ? h('div', { className: 'xhs-warn', style: { marginTop: 8 } },
              st.dryRun === false
                ? '⚠ 人工复核与演练模式都已关闭：生成的回复会直接发到小红书。'
                : '提醒：人工复核已关闭（演练模式仍开着，不会真发）。')
            : null,
          h('div', { style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(127,127,127,.25)' } },
            h('div', { className: 'xhs-label', style: { marginTop: 0 } }, '发送管控'),
            h('label', { className: 'xhs-row' },
              h('input', { type: 'checkbox', checked: !!form.require_approval, onChange: (e) => toggleSetting('require_approval', e.target.checked) }),
              h('span', null, '人工复核：每条回复都要在清单里确认后才发送')),
            h('label', { className: 'xhs-row' },
              h('input', { type: 'checkbox', checked: !!form.dry_run, onChange: (e) => toggleSetting('dry_run', e.target.checked) }),
              h('span', null, '演练模式：只生成草稿，不向平台发送')),
            h('div', { className: 'xhs-mut', style: { marginTop: 6 } }, '演练模式优先级最高：开启时任何发送动作（含人工复核）都会被拦截。'),
          ),
        ) : null,

        tab === 'scripts' ? h('div', { className: 'xhs-card' },
          h('div', { className: 'xhs-row' },
            h('span', { className: 'xhs-mut' }, scripts
              ? ((scripts.scenes || []).length + ' 个场景 · 上限 ' + ((scripts.global || {}).max_chars || '?') + ' 字')
              : '加载中…'),
            h('div', { className: 'xhs-sp' }),
            h('button', { className: 'xhs-btn', onClick: loadScripts, disabled: busy }, '刷新'),
            h('button', { className: 'xhs-btn primary', onClick: saveScripts, disabled: busy || !scripts }, '保存'),
          ),
          scriptsMsg ? h('div', { className: 'xhs-mut', style: { marginTop: 6 } }, scriptsMsg) : null,
          h('div', { className: 'xhs-mut', style: { marginTop: 6 } },
            '一条评论先按触发词归场景，再从该场景话术里挑一条；同一句不会重复用。发送前统一过合规闸。'),
          scripts ? h('div', null,
            h('label', { className: 'xhs-label' }, '搜索关键词（就搜这些词，最多前 3 个）'),
            h(ChipField, {
              value: (scripts.search && scripts.search.keywords) || [],
              placeholder: '大小脸',
              onChange: (v) => setScripts({ ...scripts, search: { ...(scripts.search || {}), keywords: v } }),
            }),
            h('label', { className: 'xhs-label' }, '作者黑名单（昵称含这些词 = 营销号，直接跳过）'),
            h(ChipField, {
              value: (scripts.global && scripts.global.skip_author_words) || [],
              placeholder: '打卡',
              onChange: (v) => setScripts({ ...scripts, global: { ...(scripts.global || {}), skip_author_words: v } }),
            }),
            h('label', { className: 'xhs-label' }, '评论黑名单（评论含这些词 = 同行 / 广告，不回复）'),
            h(ChipField, {
              value: (scripts.global && scripts.global.skip_comment_words) || [],
              placeholder: '加微',
              onChange: (v) => setScripts({ ...scripts, global: { ...(scripts.global || {}), skip_comment_words: v } }),
            }),
          ) : null,
          ((scripts && scripts.scenes) || []).map((s, i) => h('div', {
            key: s.id,
            style: { marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(127,127,127,.25)' },
          },
          h('div', { className: 'xhs-row' },
            h('input', { type: 'checkbox', checked: s.enabled !== false, onChange: (e) => patchScene(i, { enabled: e.target.checked }) }),
            h('span', null, s.name),
            h('span', { className: 'xhs-chip' }, s.mode),
            h('span', { className: 'xhs-chip' }, ((s.templates || []).length) + ' 条'),
          ),
          h('label', { className: 'xhs-label' }, '触发词（回车添加）'),
          h(ChipField, {
            value: (s.match && s.match.any) || [],
            placeholder: '大小脸',
            onChange: (v) => patchScene(i, { match: { ...(s.match || {}), any: v } }),
          }),
          h('label', { className: 'xhs-label' }, '话术池（一行一条）'),
          h('textarea', {
            className: 'xhs-area',
            style: { minHeight: 110, overflow: 'hidden', resize: 'vertical' },
            value: (s.templates || []).join('\n'),
            ref: (el) => { if (el) autoGrow(el) },
            onInput: (e) => autoGrow(e.target),
            onChange: (e) => patchScene(i, { templates: e.target.value.split('\n') }),
          }),
          s.notes ? h('div', { className: 'xhs-mut' }, s.notes) : null,
          ))
        ) : null,

        tab === 'rules' ? h('div', { className: 'xhs-card' },
          h('label', { className: 'xhs-label' }, '评论必须包含其一（空 = 不筛）'),
          h(ChipField, { value: form.must_any, placeholder: '多少钱', onChange: (v) => setForm({ ...form, must_any: v }) }),
          h('label', { className: 'xhs-label' }, '评论不能包含（黑名单）'),
          h(ChipField, { value: form.must_not, placeholder: '加微', onChange: (v) => setForm({ ...form, must_not: v }) }),
          h('label', { className: 'xhs-label' }, '回复里禁用词（命中直接拒绝发送）'),
          h(ChipField, { value: form.banned_words, placeholder: '微信', onChange: (v) => setForm({ ...form, banned_words: v }) }),
          h('div', { className: 'xhs-row' },
            h('div', null, h('label', { className: 'xhs-label' }, '评论字数上限'),
              h('input', { className: 'xhs-input', type: 'number', value: form.max_len, onChange: (e) => setForm({ ...form, max_len: e.target.value }) })),
            h('div', null, h('label', { className: 'xhs-label' }, '单篇上限'),
              h('input', { className: 'xhs-input', type: 'number', value: form.max_per_note, onChange: (e) => setForm({ ...form, max_per_note: e.target.value }) })),
          ),
          h('div', { className: 'xhs-row' },
            h('div', null, h('label', { className: 'xhs-label' }, '每小时'),
              h('input', { className: 'xhs-input', type: 'number', value: form.hourly_quota, onChange: (e) => setForm({ ...form, hourly_quota: e.target.value }) })),
            h('div', null, h('label', { className: 'xhs-label' }, '每天'),
              h('input', { className: 'xhs-input', type: 'number', value: form.daily_quota, onChange: (e) => setForm({ ...form, daily_quota: e.target.value }) })),
          ),
          h('div', { className: 'xhs-row' },
            h('div', null, h('label', { className: 'xhs-label' }, '最小间隔（秒）'),
              h('input', { className: 'xhs-input', type: 'number', value: form.min_interval_sec, onChange: (e) => setForm({ ...form, min_interval_sec: e.target.value }) })),
            h('div', null, h('label', { className: 'xhs-label' }, '回复字数'),
              h('input', { className: 'xhs-input', type: 'number', value: form.max_chars, onChange: (e) => setForm({ ...form, max_chars: e.target.value }) })),
          ),
          h('div', { style: { marginTop: 16, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)' } },
            h('div', { className: 'xhs-label', style: { marginTop: 0 } }, '运行节奏'),
            h('div', { className: 'xhs-row' },
              h('div', null, h('label', { className: 'xhs-label' }, '每轮间隔（秒）'),
                h('input', { className: 'xhs-input', type: 'number', value: form.cycle_interval_sec, onChange: (e) => setForm({ ...form, cycle_interval_sec: e.target.value }) })),
              h('div', null, h('label', { className: 'xhs-label' }, '每轮最多处理笔记'),
                h('input', { className: 'xhs-input', type: 'number', value: form.max_notes_per_cycle, onChange: (e) => setForm({ ...form, max_notes_per_cycle: e.target.value }) })),
            ),
            h('div', { className: 'xhs-mut', style: { marginTop: 6 } }, '「开始」按这个节奏一轮接一轮跑，直到点「终止」。')),
          h('div', { className: 'xhs-row', style: { marginTop: 10 } },
            h('button', { className: 'xhs-btn primary', onClick: save, disabled: busy }, '保存规则')),
        ) : null,

        tab === 'drafts' ? (drafts.length
          ? h('div', null,
            h('div', { className: 'xhs-row', style: { marginBottom: 6 } },
              h('span', { className: 'xhs-mut' }, '同一波次用同一颜色'),
              h('div', { className: 'xhs-sp' }),
              h('button', { className: 'xhs-btn', disabled: busy, onClick: clearDrafts }, '清空清单'),
            ),
            drafts.map((d, i) => h(DraftItem, {
              key: d.commentId + i,
              d,
              busy,
              canApprove: st.requireApproval !== false,
              dryRun: st.dryRun !== false,
              onSend: send,
              onSkip: skip,
              onOpenNote: openNote,
              color: d.__color,
              waveIdx: d.__wave,
            })))
          : h('div', { className: 'xhs-card xhs-mut' }, '还没有草稿。点「开始」或「跑一轮」，命中话术库的评论会出现在这里。')
        ) : null,
      )
    }

    function DraftItem(props) {
      const { d, busy, canApprove, dryRun, onSend, onSkip, onOpenNote, color, waveIdx } = props
      const [text, setText] = useState(d.replyText || '')
      return h('div', {
        className: 'xhs-card',
        style: color
          ? { borderLeft: '3px solid ' + color, background: 'linear-gradient(90deg,' + hexToRgba(color, 0.08) + ' 0%,transparent 60%)' }
          : null,
      },
        h('div', { className: 'xhs-row' },
          color ? h('span', { className: 'xhs-chip', style: { color, borderColor: color } }, '第 ' + (waveIdx + 1) + ' 波') : null,
          h('span', { className: 'xhs-chip' }, d.level === 2 ? '二级回复' : '一级评论'),
          d.sent ? h('span', { className: 'xhs-chip bad' }, '已发送') : null,
          h('span', { className: 'xhs-mut' }, fmtTime(d.createdAt)),
        ),
        h('div', { className: 'xhs-row' },
          h('span', { className: 'xhs-mut' }, (d.user || '') + (d.liked ? ' · 赞 ' + d.liked : '') + (d.sceneName ? ' · ' + d.sceneName : '')),
        ),
        h('button', {
          className: 'xhs-link',
          title: '在浏览器打开这篇小红书笔记',
          onClick: () => onOpenNote(d),
        }, '笔记：' + (d.noteTitle || '（无标题）') + ' ↗'),
        h('div', { className: 'xhs-quote' }, d.content || ''),
        h('textarea', { className: 'xhs-area', value: text, onChange: (e) => setText(e.target.value) }),
        h('div', { className: 'xhs-row', style: { marginTop: 6 } },
          canApprove
            ? h('button', { className: 'xhs-btn primary', disabled: busy || d.sent, onClick: () => onSend(d, text) }, '发送这条')
            : h('span', { className: 'xhs-mut' }, d.sent
              ? '已自动发送'
              : (dryRun ? '人工复核已关闭（当前演练模式，不会真发）' : '人工复核已关闭：生成后直接发送')),
          canApprove ? h('button', { className: 'xhs-btn', disabled: busy, onClick: () => onSkip(d) }, '跳过') : null,
        ),
      )
    }
  }

  let panelFactory = null

  window.__ModuleLoader__.load({
    id: 'dsh-xhs-comment-agent',
    factory: (require) => {
      const React = require('react')
      if (!panelFactory) panelFactory = makePanel(React)
      const Panel = panelFactory

      function Icon() {
        return React.createElement('span', {
          style: { fontSize: 14, lineHeight: '16px', display: 'inline-block' },
        }, '💬')
      }

      function tryRegister(ctx, attempt) {
        const tabs = ctx.get && ctx.get('sidebarRightTabs')
        if (!tabs || typeof tabs.register !== 'function') {
          if (attempt < 40) setTimeout(() => tryRegister(ctx, attempt + 1), 500)
          else console.warn('[xhs-agent] 右侧栏服务不可用，标签未注册')
          return
        }
        try {
          tabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            title: () => '小红书评论',
            guide: [{
              id: TAB_KIND,
              order: 520,
              title: () => '小红书评论',
              description: () => '控制运行、查看进度与 token、审核草稿、改规则',
              icon: Icon,
            }],
          })
        } catch (e) {
          console.warn('[xhs-agent] 标签注册失败：', e && e.message ? e.message : e)
          return
        }
        injectCss()
        try {
          ctx.slots.inject('sidebar.right.pane.tab', function* () {
            yield ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, order: 120 },
              () => React.createElement(Panel, {}))
          })
        } catch (e) {
          console.warn('[xhs-agent] 面板插槽注册失败：', e && e.message ? e.message : e)
        }
      }

      function apply(ctx) {
        tryRegister(ctx, 0)
      }

      return { name: 'xhs-comment-panel', inject: ['slots'], apply }
    },
  })
})()
