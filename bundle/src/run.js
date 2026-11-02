/**
 * 「开始」按钮的执行器：搜索 → 抓评论 → 生成回复 → 入清单（或直接发）。
 *
 * 拆成独立模块，避免 index.js 继续膨胀。依赖全部由调用方注入。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createRunner(deps) {
  const { api, getRules, llm, onDraft, send, log, state, persist } = deps

  const asArray = (v) => (Array.isArray(v) ? v : (v?.feeds ?? []))

  async function searchOnce(keyword, rules) {
    const sd = rules.search_defaults ?? {}
    const raw = await api('/feeds/search', {
      keyword,
      filters: {
        sort_by: '综合',
        note_type: sd.note_type ?? '不限',
        publish_time: sd.publish_time ?? '不限',
      },
    })
    return asArray(raw?.feeds ?? raw)
  }

  function pickNotes(feeds, rules) {
    const g = rules.note_gate ?? {}
    return feeds.filter((n) => {
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
      liked: Number(n?.noteCard?.interactInfo?.likedCount ?? 0),
    }))
  }

  function flatten(list, level = 1, out = []) {
    for (const c of list ?? []) {
      out.push({ ...c, level })
      const subs = c.subComments ?? []
      if (subs.length) flatten(subs, level + 1, out)
    }
    return out
  }

  function pickComments(detail, rules) {
    const node = detail?.data ?? detail ?? {}
    const all = flatten(node?.comments?.list ?? [])
    const gate = rules.comment_gate ?? {}
    return all.filter((c) => {
      if (gate.level?.length && !gate.level.includes(c.level)) return false
      const text = String(c.content ?? '')
      if (text.length > (gate.max_len ?? 120)) return false
      if (gate.exclude_authors?.includes(String(c.userInfo?.nickname ?? ''))) return false
      if (gate.must_any?.length && !gate.must_any.some((k) => text.includes(k))) return false
      if (gate.must_not?.some((k) => text.includes(k))) return false
      return true
    }).map((c) => ({
      commentId: String(c.id ?? ''),
      userId: String(c.userInfo?.userId ?? ''),
      user: c.userInfo?.nickname ?? '',
      content: c.content ?? '',
      level: c.level,
      liked: Number(c.likeCount ?? 0),
    }))
  }

  async function generateReply(note, comment, rules) {
    const rs = rules.reply_style ?? {}
    const system = [
      '你在小红书评论区回复别人，像一个真实用户。',
      rs.tone ? `语气要求：${rs.tone}` : '语气：自然、简短、像人说话，不推销。',
      `硬性要求：不超过 ${rs.max_chars ?? 60} 个汉字；不要链接、不要联系方式、不要报价。`,
      rs.banned_words?.length ? `禁止出现这些词：${rs.banned_words.join('、')}` : '',
      rs.example_good?.length ? `正面示例：\n- ${rs.example_good.join('\n- ')}` : '',
      rs.example_bad?.length ? `绝对不要这样写：\n- ${rs.example_bad.join('\n- ')}` : '',
      '只输出回复正文，不要引号、不要解释。',
    ].filter(Boolean).join('\n')

    const user = [
      `笔记标题：${note.title}`,
      `对方评论：${comment.content}`,
      comment.level === 2 ? '（这是二级回复，回复时对他/她说话）' : '（这是一级评论）',
      '写一条回复。',
    ].join('\n')

    const parts = []
    const cfg = deps.llmConfig?.() ?? {}
    const iter = llm.stream({
      provider: cfg.provider ?? 'deepseek-account',
      model: cfg.model ?? 'deepseek-flash',
      messages: [
        { role: 'system', content: [{ type: 'text', text: system }] },
        { role: 'user', content: [{ type: 'text', text: user }] },
      ],
    })
    for await (const c of iter) {
      if (c?.type === 'text-delta') parts.push(c.text)
    }
    return parts.join('').trim().replace(/^["'「]|["'」]$/g, '')
  }

  /**
   * @param {{mode:'test'|'start', keywords?:string[]}} opts
   */
  async function run(opts) {
    const rules = getRules()
    const mode = opts.mode === 'test' ? 'test' : 'start'
    const keywords = (opts.keywords?.length ? opts.keywords : rules.keywords ?? []).filter(Boolean).slice(0, 3)
    if (!keywords.length) return { ok: false, error: '先在「规则」里填搜索语句/关键词' }

    const job = {
      id: String(Date.now()),
      mode,
      phase: 'searching',
      keywords,
      notesTotal: 0,
      notesDone: 0,
      candidates: 0,
      drafted: 0,
      sent: 0,
      errors: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
    }
    state.job = job
    persist()

    const noteMap = new Map()
    for (const kw of keywords) {
      job.phase = `searching:${kw}`
      persist()
      try {
        const feeds = await searchOnce(kw, rules)
        for (const n of pickNotes(feeds, rules)) if (n.feedId && !noteMap.has(n.feedId)) noteMap.set(n.feedId, n)
      } catch (e) {
        job.errors.push(`搜索「${kw}」失败：${String(e?.message ?? e)}`)
      }
      await sleep(1200)
    }

    const notes = [...noteMap.values()].slice(0, 6)
    job.notesTotal = notes.length
    job.phase = 'collecting'
    persist()

    if (mode === 'test') {
      const preview = []
      for (const [kw] of keywords.map((k) => [k])) { /* noop */ }
      for (const n of notes) preview.push({ title: n.title, liked: n.liked, feedId: n.feedId })
      job.phase = 'done'
      job.finishedAt = new Date().toISOString()
      job.preview = preview
      persist()
      return { ok: true, job, preview }
    }

    const maxPerNote = rules.reply_policy?.max_per_note ?? 2
    for (const note of notes) {
      job.phase = `comments:${note.title.slice(0, 12)}`
      persist()
      let detail
      try {
        detail = await api('/feeds/detail', {
          feed_id: note.feedId,
          xsec_token: note.xsecToken,
          load_all_comments: true,
          comment_config: {
            click_more_replies: true,
            max_replies_threshold: 50,
            max_comment_items: 20,
            scroll_speed: 'normal',
          },
        })
      } catch (e) {
        job.errors.push(`抓评论失败：${String(e?.message ?? e)}`)
        job.notesDone += 1
        persist()
        continue
      }

      const cands = pickComments(detail, rules).slice(0, maxPerNote)
      job.candidates += cands.length
      persist()

      for (const c of cands) {
        let text
        try {
          text = await generateReply(note, c, rules)
        } catch (e) {
          job.errors.push(`生成文案失败：${String(e?.message ?? e)}`)
          continue
        }
        const rs = rules.reply_style ?? {}
        if (!text) { job.errors.push('模型返回空文案'); continue }
        if (text.length > (rs.max_chars ?? 60)) { job.errors.push(`文案超长(${text.length}): ${text.slice(0, 20)}…`); continue }
        const hit = (rs.banned_words ?? []).find((w) => w && text.includes(w))
        if (hit) { job.errors.push(`文案含禁用词「${hit}」`); continue }

        const draft = {
          feedId: note.feedId,
          xsecToken: note.xsecToken,
          noteTitle: note.title,
          ...c,
          replyText: text,
          createdAt: new Date().toISOString(),
          jobId: job.id,
        }
        onDraft(draft)
        job.drafted += 1

        if (!deps.requireApproval()) {
          job.phase = 'sending'
          persist()
          const r = await send({ feedId: note.feedId, xsecToken: note.xsecToken, commentId: c.commentId, text })
          if (r?.ok) job.sent += 1
          else job.errors.push(`发送失败：${r?.blocked ?? r?.error ?? 'unknown'}`)
          await sleep(1500)
        }
      }
      job.notesDone += 1
      persist()
      await sleep(800)
    }

    job.phase = 'done'
    job.finishedAt = new Date().toISOString()
    persist()
    log(`run ${job.id} done: notes=${job.notesTotal} drafted=${job.drafted} sent=${job.sent} errors=${job.errors.length}`)
    return { ok: true, job }
  }

  return { run }
}
