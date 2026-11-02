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
    const { useCallback, useEffect, useState } = React
  const PHASE = { searching: '搜索中', collecting: '抓评论', sending: '发送中', done: '完成', error: '出错' }
  function jobLine(job) {
    if (!job) return '还没跑过'
    const p = String(job.phase || '')
    const seg = p.split(':')
    const head = seg.length > 1 ? ((PHASE[seg[0]] || seg[0]) + ' ' + seg[1].slice(0, 14)) : (PHASE[p] || p)
    const parts = [head]
    if (job.drafted != null) parts.push('草稿 ' + job.drafted)
    if (job.sent != null) parts.push('发送 ' + job.sent)
    if (job.errors && job.errors.length) parts.push('错误 ' + job.errors.length)
    return parts.join(' · ')
  }

    return function XhsPanel() {
      const [state, setState] = useState(null)
      const [tab, setTab] = useState('drafts')
      const [form, setForm] = useState(null)
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState(false)
      const [running, setRunning] = useState(false)

      const load = useCallback(async () => {
        const s = await api('/api/state')
        if (!s || !s.status) return
        setState(s)
        setForm((prev) => prev ?? {
          keywords: (s.rules.keywords || []).join('\n'),
          require_approval: s.status.requireApproval !== false,
          must_any: ((s.rules.comment_gate || {}).must_any || []).join('\n'),
          must_not: ((s.rules.comment_gate || {}).must_not || []).join('\n'),
          max_len: (s.rules.comment_gate || {}).max_len ?? 120,
          max_per_note: (s.rules.reply_policy || {}).max_per_note ?? 2,
          hourly_quota: (s.rules.reply_policy || {}).hourly_quota ?? 5,
          daily_quota: (s.rules.reply_policy || {}).daily_quota ?? 20,
          min_interval_sec: (s.rules.reply_policy || {}).min_interval_sec ?? 45,
          max_chars: (s.rules.reply_style || {}).max_chars ?? 60,
          banned_words: ((s.rules.reply_style || {}).banned_words || []).join('\n'),
          dry_run: !!(s.rules.dry_run ?? s.status.dryRun),
        })
      }, [])

      useEffect(() => { load() }, [load])
      useEffect(() => { const t = setInterval(load, 8000); return () => clearInterval(t) }, [load])

      const save = async () => {
        setBusy(true)
        const lines = (v) => String(v || '').split('\n').map((x) => x.trim()).filter(Boolean)
        const r = await api('/api/rules', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            keywords: lines(form.keywords),
            require_approval: !!form.require_approval,
            comment_gate: { level: [1, 2], must_any: lines(form.must_any), must_not: lines(form.must_not), max_len: +form.max_len || 120 },
            reply_policy: { max_per_note: +form.max_per_note || 2, hourly_quota: +form.hourly_quota || 5, daily_quota: +form.daily_quota || 20, min_interval_sec: +form.min_interval_sec || 45 },
            reply_style: { max_chars: +form.max_chars || 60, banned_words: lines(form.banned_words) },
            dry_run: !!form.dry_run,
          }),
        })
        setBusy(false)
        setMsg(r && r.ok ? '规则已保存' : '保存失败：' + (r && r.error ? r.error : ''))
        setTimeout(() => setMsg(''), 2500)
      }

      const runNow = async (mode) => {
        setRunning(true)
        setMsg(mode === 'test' ? '测试：只搜索帖子，不抓评论…' : '开始：搜索 → 抓评论 → 生成回复')
        const r = await api('/api/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode }),
        })
        if (!r || !r.ok) {
          setRunning(false)
          setMsg(r && r.busy ? '上一轮还在跑，等它结束' : ('启动失败：' + ((r && r.error) || '')))
          setTimeout(() => setMsg(''), 3000)
          return
        }
        // 轮询任务状态
        const timer = setInterval(async () => {
          const s = await api('/api/state')
          if (!s || !s.status) return
          setState(s)
          const job = s.status.job
          if (!job || job.phase === 'done' || job.phase === 'error') {
            clearInterval(timer)
            setRunning(false)
            const errs = (job && job.errors) || []
            setMsg(job && job.phase === 'error'
              ? ('执行出错：' + errs.join('；'))
              : (mode === 'test'
                ? ('测试完成：命中 ' + ((job && job.notesTotal) || 0) + ' 篇笔记')
                : ('完成：草稿 ' + ((job && job.drafted) || 0) + ' 条，发送 ' + ((job && job.sent) || 0) + ' 条' + (errs.length ? '，错误 ' + errs.length + ' 条' : ''))))
            setTimeout(() => setMsg(''), 6000)
          }
        }, 3000)
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

      const importFile = async (file) => {
        if (!file) return
        setBusy(true)
        const buf = await file.arrayBuffer()
        const r = await api('/api/import?apply=1', {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: buf,
        })
        setBusy(false)
        setMsg(r && r.ok ? ('已导入 ' + r.filled + ' 个字段') : ('导入失败：' + (r && r.error ? r.error : '')))
        setTimeout(() => setMsg(''), 4000)
        load()
      }

      if (!state || !form) return h('div', { className: 'xhs-pane' }, h('div', { className: 'xhs-mut' }, '连接面板中…（首次启动需要几秒）'))

      const st = state.status
      const logged = st.login && st.login.is_logged_in
      const drafts = state.drafts || []

      return h('div', { className: 'xhs-pane' },
        h('div', { className: 'xhs-row' },
          h('span', { className: 'xhs-chip ' + (st.healthy ? 'ok' : 'bad') }, st.healthy ? '服务在线' : '服务离线'),
          h('span', { className: 'xhs-chip ' + (logged ? 'ok' : 'bad') }, logged ? ('已登录 · ' + (st.login.username || '')) : '未登录'),
          h('span', { className: 'xhs-chip' }, '今日 ' + st.quota.dayCount + '/' + st.quota.daily_quota),
          h('span', { className: 'xhs-chip' }, '本小时 ' + st.quota.hourCount + '/' + st.quota.hourly_quota),
        ),
        msg ? h('div', { className: 'xhs-warn' }, msg) : null,

        // 执行区：开始 = 完整跑一轮；测试 = 只搜帖子看看命中
        h('div', { className: 'xhs-row' },
          h('button', { className: 'xhs-btn primary', disabled: running, onClick: () => runNow('start') }, running ? '执行中…' : '开始'),
          h('button', { className: 'xhs-btn', disabled: running, onClick: () => runNow('test') }, '测试'),
          h('span', { className: 'xhs-mut' }, jobLine(st.job)),
        ),

        h('div', { className: 'xhs-tabs' },
          h('div', { className: 'xhs-tab ' + (tab === 'drafts' ? 'on' : ''), onClick: () => setTab('drafts') },
            (st.requireApproval === false ? '回复记录' : '回复清单') + ' (' + drafts.length + ')'),
          h('div', { className: 'xhs-tab ' + (tab === 'rules' ? 'on' : ''), onClick: () => setTab('rules') }, '规则'),
          h('div', { className: 'xhs-tab ' + (tab === 'import' ? 'on' : ''), onClick: () => setTab('import') }, '导入清单'),
        ),

        tab === 'rules' ? h('div', { className: 'xhs-card' },
          h('label', { className: 'xhs-label' }, '搜索语句 / 关键词（每行一个，最多用前 3 个）'),
          h('textarea', { className: 'xhs-area', value: form.keywords, onChange: (e) => setForm({ ...form, keywords: e.target.value }), placeholder: '上海 露营 免费营地\n明火 营地' }),
          h('label', { className: 'xhs-row', style: { marginTop: 10 } },
            h('input', { type: 'checkbox', checked: !!form.require_approval, onChange: (e) => setForm({ ...form, require_approval: e.target.checked }) }),
            h('span', null, '审核模式：生成的回复先进清单，我点「发送这条」才发')),
          h('label', { className: 'xhs-label' }, '评论必须包含其一（每行一个，空 = 不筛）'),
          h('textarea', { className: 'xhs-area', value: form.must_any, onChange: (e) => setForm({ ...form, must_any: e.target.value }) }),
          h('label', { className: 'xhs-label' }, '评论不能包含（黑名单）'),
          h('textarea', { className: 'xhs-area', value: form.must_not, onChange: (e) => setForm({ ...form, must_not: e.target.value }) }),
          h('label', { className: 'xhs-label' }, '回复里禁用词（每行一个，命中直接拒绝发送）'),
          h('textarea', { className: 'xhs-area', value: form.banned_words, onChange: (e) => setForm({ ...form, banned_words: e.target.value }) }),
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
          h('label', { className: 'xhs-row', style: { marginTop: 10 } },
            h('input', { type: 'checkbox', checked: !!form.dry_run, onChange: (e) => setForm({ ...form, dry_run: e.target.checked }) }),
            h('span', null, '干跑：只存草稿，不真发')),
          h('div', { className: 'xhs-row', style: { marginTop: 10 } },
            h('button', { className: 'xhs-btn primary', onClick: save, disabled: busy }, '保存规则')),
        ) : null,

        tab === 'import' ? h('div', { className: 'xhs-card' },
          h('div', { className: 'xhs-mut' }, '选择客户填好的 .xlsx，导入后立即生效。'),
          h('input', { type: 'file', accept: '.xlsx', style: { marginTop: 8 }, onChange: (e) => importFile(e.target.files && e.target.files[0]) }),
          h('div', { className: 'xhs-mut', style: { marginTop: 8 } }, '规则路径：' + (state.rulesPath || '')),
        ) : null,

        tab === 'drafts' ? (drafts.length
          ? drafts.map((d, i) => h(DraftItem, { key: d.commentId + i, d, busy, canApprove: st.requireApproval !== false, onSend: send, onSkip: skip }))
          : h('div', { className: 'xhs-card xhs-mut' }, '还没有草稿。在对话里说「搜露营，把候选做成草稿」，抓完评论就会出现在这里。')
        ) : null,
      )
    }

    function DraftItem(props) {
      const { d, busy, canApprove, onSend, onSkip } = props
      const [text, setText] = useState(d.replyText || '')
      return h('div', { className: 'xhs-card' },
        h('div', { className: 'xhs-row' },
          h('span', { className: 'xhs-chip' }, d.level === 2 ? '二级回复' : '一级评论'),
          d.sent ? h('span', { className: 'xhs-chip bad' }, '已发送') : null,
          h('span', { className: 'xhs-mut' }, (d.user || '') + (d.liked ? ' · 赞 ' + d.liked : '')),
        ),
        h('div', { className: 'xhs-quote' }, d.content || ''),
        h('textarea', { className: 'xhs-area', value: text, onChange: (e) => setText(e.target.value) }),
        h('div', { className: 'xhs-row', style: { marginTop: 6 } },
          canApprove
            ? h('button', { className: 'xhs-btn primary', disabled: busy || d.sent, onClick: () => onSend(d, text) }, '发送这条')
            : h('span', { className: 'xhs-mut' }, d.sent ? '已自动发送' : '自动模式：无需审核'),
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
              description: () => '审核评论草稿、改规则、导入客户清单',
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
