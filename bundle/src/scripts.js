/**
 * 话术库：校验 / 意图路由 / 模板轮换 / 合规检查。
 *
 * 设计要点：
 *   - 话术是数据（scripts.json），不是提示词的一部分，改话术不用改代码
 *   - 一条评论先路由到"场景"，只用该场景的话术池，避免答非所问
 *   - 模板模式纯轮换，绝不现场编；hybrid/llm 模式把话术当 few-shot 风格约束
 *   - 发送前统一过一遍合规闸：字数 / 禁用词 / 联系方式 / 报价 / 与最近回复的相似度
 */

const FULLWIDTH = /[\uFF01-\uFF5E]/g

/** 归一化：全角转半角、去空白、小写。用于匹配与相似度计算。 */
export function normalize(s) {
  return String(s ?? '')
    .replace(FULLWIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

export function bigrams(s) {
  const t = normalize(s)
  const set = new Set()
  for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2))
  if (!set.size && t.length) set.add(t)
  return set
}

/** 字符二元组 Jaccard 相似度，0~1。 */
export function similarity(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return inter / (A.size + B.size - inter)
}

const CONTACT_PATTERNS = [
  /微信|薇信|威信|薇新|维新|weixin|wechat|vx|wx|v信|加v|加我|v我|v你|私聊|私信|私我|滴滴我|扣我|sl我/,
  /1[3-9]\d{9}/,
  /\bqq\b|扣扣/,
  /https?:\/\/|www\.|\.com|\.cn|主页|橱窗|店铺|评论区|看简介|点我头像/,
]

const PRICE_PATTERNS = [
  /\d+(元|块|万|千|k)/i,
  /价格|报价|多少钱|便宜|优惠|折扣|原价|包邮|免费|团购|分期/,
]

const DEFAULT_GLOBAL = {
  max_chars: 120,
  min_similarity_gap: 0.82,
  recent_window: 30,
  no_contact: true,
  no_price: true,
  banned_words: [],
  // 营销号 / 机器人特征：昵称命中或评论命中正则，就直接跳过（不回复也不计候选）
  skip_author_words: ['打卡', '提醒', '机器人', '小助手', '客服', '福利号', '自动回复', '官方号', '运营号'],
  skip_content_patterns: [
    '每晚\\d{1,2}[:：]?\\d{0,2}.*提醒',
    '定时.*提醒',
    '自动回复',
  ],
}

const MODES = new Set(['template', 'hybrid', 'llm'])

/**
 * 校验并补默认值。返回 { ok, errors, warnings, lib }。
 * 校验失败时 lib 仍然是一个可用的结构（便于 UI 展示错误）。
 */
export function validateScripts(raw) {
  const errors = []
  const warnings = []
  const lib = {
    version: Number(raw?.version ?? 1),
    updated_at: raw?.updated_at ?? '',
    source: raw?.source ?? '',
    global: { ...DEFAULT_GLOBAL, ...(raw?.global ?? {}) },
    search: {
      keywords: Array.isArray(raw?.search?.keywords) ? raw.search.keywords.map(String).filter(Boolean) : [],
      sort_by: raw?.search?.sort_by ?? '综合',
      note_type: raw?.search?.note_type ?? '不限',
      publish_time: raw?.search?.publish_time ?? '不限',
    },
    fallback: {
      enabled: raw?.fallback?.enabled === true,
      mode: MODES.has(raw?.fallback?.mode) ? raw.fallback.mode : 'llm',
      priority: Number(raw?.fallback?.priority ?? 0),
      rules: { per_note: 1, per_day: 5, ...(raw?.fallback?.rules ?? {}) },
    },
    scenes: [],
  }

  if (!Array.isArray(raw?.scenes)) {
    errors.push('scenes 必须是数组')
    return { ok: false, errors, warnings, lib }
  }
  if (!raw.scenes.length) errors.push('scenes 不能为空')

  const g = lib.global
  if (typeof g.max_chars !== 'number' || g.max_chars < 10) errors.push('global.max_chars 必须是 >=10 的数字')
  if (typeof g.min_similarity_gap !== 'number' || g.min_similarity_gap <= 0 || g.min_similarity_gap > 1) {
    errors.push('global.min_similarity_gap 必须在 0~1 之间')
  }
  if (!Array.isArray(g.banned_words)) errors.push('global.banned_words 必须是数组')
  if (!Array.isArray(g.skip_author_words)) errors.push('global.skip_author_words 必须是数组')
  if (!Array.isArray(g.skip_content_patterns)) errors.push('global.skip_content_patterns 必须是数组')

  const ids = new Set()
  for (const [i, s] of raw.scenes.entries()) {
    const at = `scenes[${i}]`
    if (!s || typeof s !== 'object') { errors.push(`${at} 不是对象`); continue }
    if (!s.id || !/^[a-zA-Z0-9_-]+$/.test(String(s.id))) errors.push(`${at}.id 只能包含字母数字下划线短横`)
    else if (ids.has(s.id)) errors.push(`${at}.id 重复：${s.id}`)
    else ids.add(s.id)

    if (!s.name) errors.push(`${at}.name 不能为空`)
    if (!MODES.has(s.mode)) errors.push(`${at}.mode 只能是 template / hybrid / llm`)

    const match = s.match ?? {}
    if (match.any && !Array.isArray(match.any)) errors.push(`${at}.match.any 必须是数组`)
    const templates = Array.isArray(s.templates) ? s.templates.filter((t) => String(t).trim()) : []
    if ((s.mode === 'template' || s.mode === 'hybrid') && !templates.length) {
      errors.push(`${at} 是 ${s.mode} 模式，模板不能为空`)
    }
    if (s.mode === 'template' && templates.length < 3) {
      warnings.push(`${s.name}：模板只有 ${templates.length} 条，容易重复，建议 >=5 条`)
    }

    for (const [ti, t] of templates.entries()) {
      const len = String(t).length
      if (len > g.max_chars) warnings.push(`${s.name} 第 ${ti + 1} 条超过 ${g.max_chars} 字（${len}）`)
      if (g.no_contact && CONTACT_PATTERNS.some((re) => re.test(normalize(t)))) {
        warnings.push(`${s.name} 第 ${ti + 1} 条疑似含联系方式`)
      }
      if (g.no_price && PRICE_PATTERNS.some((re) => re.test(normalize(t)))) {
        warnings.push(`${s.name} 第 ${ti + 1} 条疑似含价格`)
      }
    }

    lib.scenes.push({
      id: String(s.id ?? `scene_${i}`),
      name: String(s.name ?? s.id ?? `场景 ${i + 1}`),
      enabled: s.enabled !== false,
      priority: Number(s.priority ?? 50),
      mode: MODES.has(s.mode) ? s.mode : 'template',
      match: {
        any: (match.any ?? []).map(String).filter(Boolean),
        none: (match.none ?? []).map(String).filter(Boolean),
      },
      rules: { per_note: 2, per_day: 10, ...(s.rules ?? {}) },
      notes: String(s.notes ?? ''),
      templates: templates.map(String),
    })
  }

  return { ok: errors.length === 0, errors, warnings, lib }
}

/**
 * 意图路由：按 priority 从高到低，找第一个命中的启用场景。
 * 命中规则：match.none 不含，且 match.any 为空（兜底场景）或任一关键词命中。
 */
export function matchScene(lib, text) {
  if (!lib?.scenes?.length) return null
  const t = normalize(text)
  const ordered = lib.scenes
    .filter((s) => s.enabled)
    .slice()
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

  for (const s of ordered) {
    if (s.match.none?.some((k) => t.includes(normalize(k)))) continue
    if (!s.match.any?.length) {
      // 没有触发词的场景只在允许兜底时才用
      if (lib.fallback?.enabled && s.id === 'fallback') return s
      continue
    }
    if (s.match.any.some((k) => t.includes(normalize(k)))) return s
  }
  return null
}

/**
 * 选一条模板：优先用得最少的；若与最近回复过于相似就跳过，全部都不行时返回 null
 * （宁可不回，也不要复读同一句）。
 */
export function pickTemplate(lib, scene, recentTexts = [], usage = {}) {
  const gap = Number(lib?.global?.min_similarity_gap ?? 0.82)
  const pool = (scene?.templates ?? []).filter(Boolean)
  if (!pool.length) return null

  const scored = pool.map((text, i) => {
    const key = `${scene.id}#${i}`
    const u = usage[key] ?? {}
    return { text, key, count: Number(u.count ?? 0), lastUsed: Number(u.lastUsed ?? 0) }
  })
  scored.sort((a, b) => (a.count - b.count) || (a.lastUsed - b.lastUsed))

  for (const c of scored) {
    const tooClose = recentTexts.some((r) => similarity(r, c.text) >= gap)
    if (!tooClose) return c
  }
  return null
}

/**
 * 发送前合规闸。返回 null 表示通过，否则返回 { blocked, detail }。
 */
export function checkReply(text, lib, recentTexts = []) {
  const g = { ...DEFAULT_GLOBAL, ...(lib?.global ?? {}) }
  const t = String(text ?? '').trim()
  if (!t) return { blocked: 'empty_text', detail: '文案为空' }

  if (t.length > g.max_chars) {
    return { blocked: 'too_long', detail: `${t.length} 字，超过上限 ${g.max_chars}` }
  }

  const n = normalize(t)

  for (const w of g.banned_words ?? []) {
    if (w && n.includes(normalize(w))) return { blocked: 'banned_word', detail: `出现禁用词「${w}」` }
  }

  if (g.no_contact !== false) {
    for (const re of CONTACT_PATTERNS) {
      if (re.test(n)) return { blocked: 'contact', detail: '疑似含联系方式 / 导流信息' }
    }
  }

  if (g.no_price !== false) {
    for (const re of PRICE_PATTERNS) {
      if (re.test(n)) return { blocked: 'price', detail: '疑似含价格 / 优惠信息' }
    }
  }

  const gap = Number(g.min_similarity_gap ?? 0.82)
  const dup = (recentTexts ?? []).find((r) => similarity(r, t) >= gap)
  if (dup) return { blocked: 'too_similar', detail: `与最近一条回复过于相似（${Math.round(similarity(dup, t) * 100)}%）` }

  return null
}

/**
 * 营销号 / 机器人过滤：昵称命中特征词，或评论命中特征正则，就跳过这条评论。
 * 返回 null 表示正常，否则返回命中原因。
 */
export function isSkippableAuthor(lib, user, content) {
  const g = { ...DEFAULT_GLOBAL, ...(lib?.global ?? {}) }
  const name = normalize(user)
  const text = normalize(content)

  if (name) {
    for (const w of g.skip_author_words ?? []) {
      const kw = normalize(w)
      if (kw && name.includes(kw)) return { why: 'author', hit: w }
    }
  }

  for (const p of g.skip_content_patterns ?? []) {
    if (!p) continue
    try {
      if (new RegExp(p).test(text)) return { why: 'content', hit: p }
    } catch { /* 非法正则忽略 */ }
  }

  return null
}

/** 给 hybrid / llm 模式拼风格参考：随机取该场景的几条话术，当 few-shot。 */
export function styleSamples(scene, count = 3) {
  const pool = (scene?.templates ?? []).filter(Boolean)
  if (!pool.length) return []
  const copy = pool.slice()
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, Math.min(count, copy.length))
}
