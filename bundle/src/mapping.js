/**
 * 把客户填的 Excel 映射成引擎要的 rules.json。
 * 字段名的英文 key 写在 A 列的括号里，例如「关注关键词（keywords）」。
 */

const REQUIRED = [
  ['scope', '回复范围'],
  ['keywords', '关注关键词'],
  ['level', '回复哪一层'],
  ['must_not', '评论不能包含'],
  ['tone', '语气'],
  ['max_chars', '回复最大字数'],
  ['banned_words', '回复里禁用词'],
  ['dry_run', '先干跑'],
  ['daily_quota', '每天最多回复'],
  ['hourly_quota', '每小时最多回复'],
  ['min_interval_sec', '两条之间最小间隔'],
  ['max_per_note', '同一篇笔记最多回复'],
]

const list = (v) => {
  const raw = String(v ?? '').trim()
  if (!raw) return []
  let parts = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (parts.length === 1 && /[，,]/.test(parts[0])) parts = parts[0].split(/[，,]/).map((s) => s.trim()).filter(Boolean)
  return [...new Set(parts)]
}

const int = (v, def) => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : def
}

const boolOf = (v) => /^(是|对|yes|true|1|要)$/i.test(String(v ?? '').trim())

const levels = (v) => {
  const s = String(v ?? '').replace(/\s/g, '')
  const out = []
  if (s.includes('1')) out.push(1)
  if (s.includes('2')) out.push(2)
  return out.length ? out : [1, 2]
}

const scopeOf = (v) => {
  const s = String(v ?? '')
  if (s.includes('自己') && s.includes('别人')) return 'both'
  if (s.includes('自己')) return 'own'
  if (s.includes('别人')) return 'others'
  return 'others'
}

/** @returns {{rules:object, fields:Record<string,string>, missing:string[], warnings:string[]}} */
export function mapWorkbook(sheets) {
  const fields = {}
  for (const sheet of sheets) {
    for (const row of sheet.rows ?? []) {
      const label = String(row?.[0] ?? '').trim()
      const value = String(row?.[1] ?? '').trim()
      const m = /[（(]\s*([a-z_]+)\s*[）)]/.exec(label)
      if (m && value) fields[m[1]] = value
    }
  }

  const missing = REQUIRED.filter(([k]) => !fields[k]).map(([, label]) => label)
  const warnings = []

  const scope = scopeOf(fields.scope)
  if (scope === 'own' || scope === 'both') {
    warnings.push('「自己笔记下的评论」走通知接口，当前版本还没接；本轮只处理别人笔记的评论区。')
  }

  const mustAny = list(fields.must_any)
  if (!mustAny.length) warnings.push('「评论必须包含其一」是空的：会命中所有评论，建议先开干跑观察。')

  if (!fields.dry_run) warnings.push('没有填「先干跑」，已默认按「是」处理。')
  const dryRun = fields.dry_run ? boolOf(fields.dry_run) : true
  if (!dryRun) warnings.push('干跑已关闭：面板上点「发送」会真的发出去。')

  const rules = {
    keywords: list(fields.keywords),
    scope,
    account_label: fields.account_label ?? '',
    account_name: fields.account_name ?? '',
    search_defaults: {
      publish_time: fields.publish_time || '不限',
      note_type: fields.note_type || '不限',
    },
    note_gate: {
      min_liked: int(fields.min_liked, 0),
      title_must_any: list(fields.title_must_any),
      title_must_not: list(fields.title_must_not),
    },
    comment_gate: {
      level: levels(fields.level),
      min_liked: 0,
      must_any: mustAny,
      must_not: list(fields.must_not),
      max_len: int(fields.max_len, 120),
      exclude_authors: list(fields.exclude_authors),
    },
    reply_policy: {
      max_per_note: int(fields.max_per_note, 2),
      daily_quota: int(fields.daily_quota, 20),
      hourly_quota: int(fields.hourly_quota, 5),
      min_interval_sec: int(fields.min_interval_sec, 45),
    },
    reply_style: {
      max_chars: int(fields.max_chars, 60),
      tone: fields.tone ?? '',
      signature: fields.signature ?? '',
      banned_words: list(fields.banned_words),
      example_good: list(fields.example_good),
      example_bad: list(fields.example_bad),
    },
    work_hours: fields.work_hours ?? '',
    dry_run: dryRun,
    imported_at: new Date().toISOString(),
  }

  return { rules, fields, missing, warnings }
}
