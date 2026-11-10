/**
 * 执行器：搜索 → 抓评论 → 生成回复 → 入清单。
 *
 * 两种模式：
 *   once —— 跑一轮就停（「跑一轮」按钮，用于验收规则）
 *   loop —— 一轮接一轮，直到被终止（「开始」按钮）
 *
 * 暂停 / 继续 / 终止由注入的 control 在每次外部调用前检查；
 * control.checkpoint() 会在暂停时挂起、终止时抛 STOP。
 *
 * token 用量来自 llm 流里的 { type:'usage' } chunk，是真实值，不做估算。
 */
import { matchScene, pickTemplate, checkReply, styleSamples, isSkippableAuthor, isBlacklistedComment, isBlockedIp } from './scripts.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const STOP = Symbol('xhs-stop')

export function createRunner(deps) {
  const { api, getRules, llm, onDraft, send, log, state, persist, requireApproval, onUsage, control } = deps

  // 话术库每次现读：改 scripts.json 不用重启
  const readScripts = () => {
    try { return deps.getScripts ? deps.getScripts() : null } catch (e) { log(`scripts load failed: ${e?.message ?? e}`); return null }
  }

  const now = () => new Date().toISOString()
  const errMsg = (e) => String((e && e.message) || e)
  const patch = (p) => { state.job = { ...(state.job ?? {}), ...p }; persist() }
  const num = (v, lo, hi, d) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
  }
  const addError = (m) => {
    const errors = Array.isArray(state.job?.errors) ? state.job.errors.slice() : []
    errors.push(m)
    patch({ errors: errors.slice(-50) })
  }

  // ---- 处理过的评论：loop 模式下避免对同一条评论反复生成草稿 ----
  const SEEN_TTL_MS = 7 * 24 * 3600 * 1000
  const seenMap = () => {
    if (!state.seen || typeof state.seen !== 'object') state.seen = {}
    return state.seen
  }
  const seenHit = (id) => {
    const at = seenMap()[String(id)]
    return !!at && (Date.now() - new Date(at).getTime()) < SEEN_TTL_MS
  }
  const seenMark = (id) => {
    const m = seenMap()
    m[String(id)] = now()
    const cut = Date.now() - SEEN_TTL_MS
    for (const [k, v] of Object.entries(m)) {
      if (new Date(v).getTime() < cut) delete m[k]
    }
  }

  // 记住刚生成的回复：用于相似度去重与模板轮换
  const rememberReply = (text, templateKey) => {
    const arr = Array.isArray(state.recentReplies) ? state.recentReplies : (state.recentReplies = [])
    arr.push(text)
    const win = Number(readScripts()?.global?.recent_window ?? 30)
    while (arr.length > Math.max(5, win)) arr.shift()
    if (templateKey) {
      if (!state.templateUsage || typeof state.templateUsage !== 'object') state.templateUsage = {}
      const cur = state.templateUsage[templateKey] ?? { count: 0, lastUsed: 0 }
      state.templateUsage[templateKey] = { count: Number(cur.count ?? 0) + 1, lastUsed: Date.now() }
    }
  }

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

  async function generateReply(note, comment, rules, scene = null) {
    const rs = rules.reply_style ?? {}
    const samples = scene ? styleSamples(scene, 3) : []
    const maxChars = scene
      ? Number(readScripts()?.global?.max_chars ?? rs.max_chars ?? 120)
      : (rs.max_chars ?? 60)

    const system = [
      '你在小红书评论区回复别人，像一个真实用户。',
      rs.tone ? `语气要求：${rs.tone}` : '语气：自然、简短、像人说话，不推销。',
      `硬性要求：不超过 ${maxChars} 个汉字；不要链接、不要联系方式、不要报价。`,
      '不许做诊断结论、不许承诺疗效、不许提机构或医生姓名。',
      rs.banned_words?.length ? `禁止出现这些词：${rs.banned_words.join('、')}` : '',
      samples.length
        ? `下面是同类真实用户在这种笔记下的说法，只学语气和角度，不要照抄原句：\n- ${samples.join('\n- ')}`
        : '',
      rs.example_good?.length ? `正面示例：\n- ${rs.example_good.join('\n- ')}` : '',
      rs.example_bad?.length ? `绝对不要这样写：\n- ${rs.example_bad.join('\n- ')}` : '',
      '只输出回复正文，不要引号、不要解释。',
    ].filter(Boolean).join('\n')

    const user = [
      `笔记标题：${note.title}`,
      `对方评论：${comment.content}`,
      scene ? `评论类型：${scene.name}` : '',
      comment.level === 2 ? '（这是二级回复，回复时对他/她说话）' : '（这是一级评论）',
      '写一条回复。',
    ].filter(Boolean).join('\n')

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
      else if (c?.type === 'usage' && c.usage) onUsage?.(c.usage)
    }
    return parts.join('').trim().replace(/^["'「]|["'」]$/g, '')
  }

  /** 跑一轮：搜索 → 逐篇抓评论 → 按规则筛 → 生成草稿（审核模式下不发送）。 */
  async function runCycle(cycleNo) {
    const rules = getRules()
    const scriptsLib = readScripts()
    // 搜索词优先取话术库（一处配置全搞定）；没配才回退到规则页
    const libKeywords = (scriptsLib?.search?.keywords ?? []).filter(Boolean)
    const keywords = (libKeywords.length ? libKeywords : (rules.keywords ?? [])).filter(Boolean).slice(0, 3)
    if (!keywords.length) throw new Error('先在「话术库」里填搜索关键词')

    patch({ phase: 'searching', current: { action: 'searching', keyword: null, cycle: cycleNo } })

    const noteMap = new Map()
    for (const kw of keywords) {
      await control.checkpoint()
      patch({ phase: `searching:${kw}`, current: { action: 'searching', keyword: kw, cycle: cycleNo } })
      try {
        const feeds = await searchOnce(kw, rules)
        let hit = 0
        for (const n of pickNotes(feeds, rules)) {
          hit += 1
          if (n.feedId && !noteMap.has(n.feedId)) noteMap.set(n.feedId, n)
        }
        patch({ noteHits: (state.job?.noteHits ?? 0) + hit, feedsScanned: (state.job?.feedsScanned ?? 0) + feeds.length })
      } catch (e) {
        addError(`搜索「${kw}」失败：${errMsg(e)}`)
      }
      await sleep(1200)
    }

    const maxNotes = num(rules.reply_policy?.max_notes_per_cycle, 1, 50, 6)
    const notes = [...noteMap.values()].slice(0, maxNotes)
    patch({ notesTotal: (state.job?.notesTotal ?? 0) + notes.length, cycleNotes: notes.length, cycleDone: 0 })

    const maxPerNote = num(rules.reply_policy?.max_per_note, 1, 20, 3)
    for (const note of notes) {
      await control.checkpoint()
      patch({
        phase: `comments:${String(note.title).slice(0, 12)}`,
        current: { action: 'comments', noteTitle: note.title, feedId: note.feedId, cycle: cycleNo },
      })

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
        addError(`抓评论失败：${errMsg(e)}`)
        patch({ cycleDone: (state.job?.cycleDone ?? 0) + 1 })
        continue
      }

      // IP 属地过滤：搜索结果里没有 ipLocation，只有详情里有，所以放在这里判。
      // 命中就整篇跳过（不取评论、不生成）；ipLocation 为空表示平台没给，按不屏蔽处理。
      const ipLocation = String(detail?.data?.note?.ipLocation ?? detail?.note?.ipLocation ?? '').trim()
      const ipHit = scriptsLib ? isBlockedIp(scriptsLib, ipLocation) : null
      if (ipHit) {
        patch({
          skippedIp: (state.job?.skippedIp ?? 0) + 1,
          cycleDone: (state.job?.cycleDone ?? 0) + 1,
          notesDone: (state.job?.notesDone ?? 0) + 1,
        })
        log(`skip note by ip: ${ipLocation} «${String(note.title).slice(0, 20)}»`)
        continue
      }

      // 同行 / 广告 / 营销号先剔掉，别浪费配额和话术
      let cands = pickComments(detail, rules)
      if (scriptsLib) {
        let black = 0
        let bot = 0
        cands = cands.filter((c) => {
          // 1) 评论内容含同行/广告/引流词 → 不回复
          if (isBlacklistedComment(scriptsLib, c.content, rules.comment_gate?.must_not ?? [])) { black += 1; return false }
          // 2) 昵称像营销号，或评论命中营销号句式
          if (isSkippableAuthor(scriptsLib, c.user, c.content)) { bot += 1; return false }
          return true
        })
        if (black) patch({ skippedBlacklist: (state.job?.skippedBlacklist ?? 0) + black })
        if (bot) patch({ skippedAuthor: (state.job?.skippedAuthor ?? 0) + bot })
      }
      patch({ candidates: (state.job?.candidates ?? 0) + cands.length })

      let used = 0
      const usedByScene = {}
      for (const c of cands) {
        if (used >= maxPerNote) break
        await control.checkpoint()
        if (seenHit(c.commentId)) {
          patch({ skippedSeen: (state.job?.skippedSeen ?? 0) + 1 })
          continue
        }

        // ---- 意图路由：先判断这条评论属于哪个场景 ----
        let scene = null
        if (scriptsLib) {
          scene = matchScene(scriptsLib, c.content)
          if (!scene) {
            patch({ skippedNoScene: (state.job?.skippedNoScene ?? 0) + 1 })
            continue
          }
          const perNote = num(scene.rules?.per_note, 1, 50, 2)
          if ((usedByScene[scene.id] ?? 0) >= perNote) {
            patch({ skippedSceneQuota: (state.job?.skippedSceneQuota ?? 0) + 1 })
            continue
          }
        }

        patch({
          phase: 'generating',
          current: {
            action: 'generating',
            noteTitle: note.title,
            commentUser: c.user,
            commentText: String(c.content).slice(0, 60),
            sceneName: scene?.name ?? '',
            cycle: cycleNo,
          },
        })

        let text = ''
        let meta = {}
        try {
          if (scene && scene.mode === 'template') {
            const pick = pickTemplate(scriptsLib, scene, state.recentReplies ?? [], state.templateUsage ?? {})
            if (!pick) {
              // 该场景的话术最近都用过，宁可不回也不复读
              patch({ skippedRepeat: (state.job?.skippedRepeat ?? 0) + 1 })
              continue
            }
            text = pick.text
            meta = { sceneId: scene.id, sceneName: scene.name, templateKey: pick.key }
          } else {
            text = await generateReply(note, c, rules, scene)
            meta = scene ? { sceneId: scene.id, sceneName: scene.name } : {}
          }
        } catch (e) {
          addError(`生成文案失败：${errMsg(e)}`)
          continue
        }

        const rs = rules.reply_style ?? {}
        if (!text) { addError('模型返回空文案'); continue }

        // ---- 合规闸：话术库启用时用脚本库的全局规则，否则退回旧规则 ----
        if (scriptsLib) {
          const bad = checkReply(text, scriptsLib, state.recentReplies ?? [])
          if (bad) {
            patch({ blocked: (state.job?.blocked ?? 0) + 1 })
            addError(`合规拦截（${bad.blocked}）：${bad.detail}`)
            continue
          }
        } else {
          if (text.length > (rs.max_chars ?? 60)) { addError(`文案超长(${text.length}): ${text.slice(0, 20)}…`); continue }
          const hitWord = (rs.banned_words ?? []).find((w) => w && text.includes(w))
          if (hitWord) { addError(`文案含禁用词「${hitWord}」`); continue }
        }

        const draft = {
          feedId: note.feedId,
          xsecToken: note.xsecToken,
          noteTitle: note.title,
          ...c,
          replyText: text,
          createdAt: now(),
          jobId: state.job?.id ?? '',
          cycle: cycleNo,
          ...meta,
        }
        onDraft(draft)
        seenMark(c.commentId)
        rememberReply(text, meta.templateKey)
        usedByScene[scene?.id ?? ''] = (usedByScene[scene?.id ?? ''] ?? 0) + 1
        patch({
          drafted: (state.job?.drafted ?? 0) + 1,
          current: { ...(state.job?.current ?? {}), action: 'drafted', replyText: text.slice(0, 60) },
        })
        used += 1

        // 人工复核关闭时才自动发；开启时草稿停在清单里等人点
        if (!requireApproval()) {
          await control.checkpoint()
          patch({ phase: 'sending' })
          const r = await send({ feedId: note.feedId, xsecToken: note.xsecToken, commentId: c.commentId, text })
          if (r?.ok) patch({ sent: (state.job?.sent ?? 0) + 1 })
          else addError(`发送失败：${r?.blocked ?? r?.error ?? 'unknown'}`)
          await sleep(1500)
        }
      }

      patch({ cycleDone: (state.job?.cycleDone ?? 0) + 1, notesDone: (state.job?.notesDone ?? 0) + 1 })
      await sleep(800)
    }
  }

  /**
   * @param {{mode?:'once'|'loop'}} opts
   */
  async function run(opts = {}) {
    const mode = opts.mode === 'loop' ? 'loop' : 'once'
    control.reset()
    state.job = {
      id: String(Date.now()),
      mode,
      status: 'running',
      phase: 'starting',
      current: null,
      cycles: 0,
      notesTotal: 0,
      notesDone: 0,
      noteHits: 0,
      feedsScanned: 0,
      candidates: 0,
      drafted: 0,
      sent: 0,
      skippedSeen: 0,
      skippedAuthor: 0,
      skippedBlacklist: 0,
      skippedIp: 0,
      skippedNoScene: 0,
      skippedRepeat: 0,
      skippedSceneQuota: 0,
      blocked: 0,
      errors: [],
      tokens: { input: 0, output: 0, total: 0, calls: 0 },
      startedAt: now(),
      finishedAt: null,
    }
    persist()

    try {
      do {
        state.job.cycles = (state.job.cycles ?? 0) + 1
        patch({ phase: 'cycle-start' })
        await runCycle(state.job.cycles)

        if (mode === 'once') break

        // 轮间等待：仍然响应暂停与终止
        const gap = num(getRules().reply_policy?.cycle_interval_sec, 10, 3600, 60)
        patch({
          phase: 'idle-between-cycles',
          current: { action: 'waiting', seconds: gap, nextCycle: state.job.cycles + 1 },
        })
        for (let s = 0; s < gap; s++) {
          await control.checkpoint()
          await sleep(1000)
        }
      } while (true)

      patch({ status: 'done', phase: 'done', current: null, finishedAt: now() })
      log(`run done: mode=${mode} cycles=${state.job.cycles} drafted=${state.job.drafted} sent=${state.job.sent}`)
    } catch (e) {
      if (e === STOP) {
        patch({ status: 'stopped', phase: 'stopped', current: null, finishedAt: now() })
        log(`run stopped: cycles=${state.job.cycles} drafted=${state.job.drafted}`)
      } else {
        addError(errMsg(e))
        patch({ status: 'error', phase: 'error', current: null, finishedAt: now() })
        log(`run error: ${errMsg(e)}`)
      }
    }
  }

  return { run }
}
