export const LIMITS = Object.freeze({
  titleMin: 3,
  titleMax: 120,
  postMax: 4000,
  replyMax: 2000,
  feedbackMax: 2000,
  displayNameMax: 30,
  taglineMax: 60,
  bioMax: 500,
  pageSize: 20,
})

export const ROLES = Object.freeze({
  committee: '领航执委会',
  mentor: '领航导师',
  student: '领航学员',
  other: '其他成员',
})

export const GRADUATION_YEAR_MIN = 2016
export const GRADUATION_YEAR_MAX = 2027

const LINKEDIN_URL = /^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]{3,100}\/?$/
const CONTACT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const WECHAT_ID = /^[A-Za-z][A-Za-z0-9_-]{5,19}$/
const STORAGE_AVATAR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/i
const DATA_AVATAR = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/i

export function normalizeText(value) {
  return String(value ?? '').trim()
}

export function normalizeInviteCode(value) {
  return String(value ?? '').trim().toUpperCase()
}

export function validateInviteCode(value) {
  const code = normalizeInviteCode(value)
  if (!code) {
    return { ok: false, message: '请输入邀请码。' }
  }
  return { ok: true, value: code }
}

export function validatePost(title, body) {
  const cleanTitle = normalizeText(title)
  const cleanBody = normalizeText(body)

  if (cleanTitle.length < LIMITS.titleMin) {
    return { ok: false, message: `标题至少需要 ${LIMITS.titleMin} 个字。` }
  }
  if (cleanTitle.length > LIMITS.titleMax) {
    return { ok: false, message: `标题不能超过 ${LIMITS.titleMax} 个字。` }
  }
  if (!cleanBody) {
    return { ok: false, message: '请补充一些具体背景。' }
  }
  if (cleanBody.length > LIMITS.postMax) {
    return { ok: false, message: `正文不能超过 ${LIMITS.postMax} 个字。` }
  }

  return { ok: true, value: { title: cleanTitle, body: cleanBody } }
}

export function validateReply(body, anonymous = false) {
  const cleanBody = normalizeText(body)

  if (!cleanBody) {
    return { ok: false, message: '回复不能为空。' }
  }
  if (cleanBody.length > LIMITS.replyMax) {
    return { ok: false, message: `回复不能超过 ${LIMITS.replyMax} 个字。` }
  }

  return { ok: true, value: { body: cleanBody, is_anonymous: Boolean(anonymous) } }
}

export function validateFeedback(body) {
  const cleanBody = normalizeText(body)

  if (!cleanBody) {
    return { ok: false, message: '请写下你的反馈。' }
  }
  if (cleanBody.length > LIMITS.feedbackMax) {
    return { ok: false, message: `反馈不能超过 ${LIMITS.feedbackMax} 个字。` }
  }

  return { ok: true, value: { body: cleanBody } }
}

export function formatRelativeTime(input, now = Date.now()) {
  const timestamp = new Date(input).getTime()
  if (!Number.isFinite(timestamp)) return '刚刚'

  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return '刚刚'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`

  return new Intl.DateTimeFormat('zh-CN', {
    year: new Date(input).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(input))
}

export function safeAvatarUrl(value) {
  if (!value) return null

  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function isDataAvatar(text) {
  return text.length <= 200_000 && DATA_AVATAR.test(text)
}

export function isUploadedAvatar(value) {
  const text = String(value ?? '')
  return STORAGE_AVATAR.test(text) || isDataAvatar(text)
}

export function displayAvatarUrl(value, storageBase = '') {
  const text = String(value ?? '')
  if (STORAGE_AVATAR.test(text)) {
    return storageBase ? safeAvatarUrl(`${storageBase}/storage/v1/object/public/avatars/${text}`) : null
  }
  if (isDataAvatar(text)) return text
  return safeAvatarUrl(text)
}

export function roleLabel(role, cohortName = '') {
  const label = ROLES[role]
  if (!label) return ''
  const cohort = normalizeText(cohortName)
  if (role === 'student' && cohort) return `${label} · ${cohort}`
  return label
}

export function graduationLabel(year) {
  const value = Number(year)
  if (!Number.isInteger(value) || value < GRADUATION_YEAR_MIN || value > GRADUATION_YEAR_MAX) return ''
  return `${value} 届`
}

const CONTROL_CHARS = /[\u0000-\u001F]/

function fitsLine(text, max) {
  return !CONTROL_CHARS.test(text) && [...text].length <= max
}

export function validateProfile(input) {
  const displayName = normalizeText(input?.display_name)
  if (!displayName || !fitsLine(displayName, LIMITS.displayNameMax)) {
    return { ok: false, message: '昵称需要 1 到 30 个字，且不能换行。' }
  }

  const tagline = normalizeText(input?.tagline)
  if (tagline && !fitsLine(tagline, LIMITS.taglineMax)) {
    return { ok: false, message: '一句话介绍不能超过 60 个字，且不能换行。' }
  }

  const bio = normalizeText(input?.bio)
  if ([...bio].length > LIMITS.bioMax) {
    return { ok: false, message: '自我介绍不能超过 500 个字。' }
  }

  const linkedin = normalizeText(input?.linkedin_url)
  if (linkedin && !LINKEDIN_URL.test(linkedin)) {
    return { ok: false, message: 'LinkedIn 请填写 https://www.linkedin.com/in/… 形式的链接。' }
  }

  const email = normalizeText(input?.contact_email).toLowerCase()
  if (email && (email.length > 120 || !CONTACT_EMAIL.test(email))) {
    return { ok: false, message: '公开邮箱的格式不对。' }
  }

  const wechat = normalizeText(input?.wechat_id)
  if (wechat && !WECHAT_ID.test(wechat)) {
    return { ok: false, message: '微信号需以字母开头，6 到 20 位，只能包含字母、数字、下划线或连字符。' }
  }

  const role = normalizeText(input?.role)
  if (role && !Object.hasOwn(ROLES, role)) {
    return { ok: false, message: '请选择领航执委会、领航导师、领航学员或其他成员。' }
  }

  const studentNumber = (value) => (role === 'student' && value != null && value !== '' ? Number(value) : null)
  const cohortId = studentNumber(input?.cohort_id)
  if (cohortId != null && !Number.isInteger(cohortId)) {
    return { ok: false, message: '请选择一个有效的班级。' }
  }
  const graduationYear = studentNumber(input?.graduation_year)
  if (graduationYear != null && !graduationLabel(graduationYear)) {
    return { ok: false, message: '毕业年份请选择 2016 到 2027。' }
  }

  return {
    ok: true,
    value: {
      display_name: displayName,
      tagline: tagline || null,
      bio: bio || null,
      linkedin_url: linkedin || null,
      linkedin_public: Boolean(linkedin) && Boolean(input?.linkedin_public),
      contact_email: email || null,
      email_public: Boolean(email) && Boolean(input?.email_public),
      wechat_id: wechat || null,
      wechat_public: Boolean(wechat) && Boolean(input?.wechat_public),
      role: role || null,
      cohort_id: cohortId,
      graduation_year: graduationYear,
    },
  }
}

export function validLinkedInUrl(value) {
  return LINKEDIN_URL.test(normalizeText(value))
}

export function validContactEmail(value) {
  return CONTACT_EMAIL.test(normalizeText(value))
}

export function displayName(user) {
  return (
    normalizeText(user?.user_metadata?.full_name) ||
    normalizeText(user?.user_metadata?.name) ||
    'Google 用户'
  ).slice(0, 80)
}

export function initials(name) {
  const cleanName = normalizeText(name)
  if (!cleanName) return '人'

  const chunks = cleanName.split(/\s+/).filter(Boolean)
  if (chunks.length > 1) {
    return `${chunks[0][0]}${chunks.at(-1)[0]}`.toUpperCase()
  }
  return cleanName.slice(0, 2).toUpperCase()
}

export function excerptPlain(source, max = 48) {
  const text = String(source ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/[#>`_~]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/([\u3400-\u9FFF])\s+(?=[\u3400-\u9FFF])/g, '$1')
    .trim()
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, max).join('').trim()}…`
}

export function compareReplies(a, b) {
  const voteDiff = (Number(b?.upvote_count) || 0) - (Number(a?.upvote_count) || 0)
  if (voteDiff !== 0) return voteDiff

  const timeA = new Date(a?.created_at).getTime()
  const timeB = new Date(b?.created_at).getTime()
  const safeA = Number.isFinite(timeA) ? timeA : 0
  const safeB = Number.isFinite(timeB) ? timeB : 0
  if (safeA !== safeB) return safeA - safeB

  return (Number(a?.id) || 0) - (Number(b?.id) || 0)
}

export function sortReplies(replies) {
  return [...(replies || [])].sort(compareReplies)
}

export function withVoteState(item, liked) {
  return {
    ...item,
    upvote_count: Math.max(0, Number(item.upvote_count) || 0),
    liked_by_me: Boolean(liked),
  }
}

// Root replies keep vote ranking; conversations always read oldest to newest.
export function groupReplyThreads(replies) {
  const byId = new Map(replies.map(reply => [String(reply.id), reply]))
  const groups = new Map()
  for (const reply of replies) {
    let root = reply
    const visited = new Set([String(root.id)])
    while (root.parent_reply_id != null && byId.has(String(root.parent_reply_id))) {
      const parent = byId.get(String(root.parent_reply_id))
      if (String(parent.post_id) !== String(reply.post_id) || visited.has(String(parent.id))) break
      visited.add(String(parent.id))
      root = parent
    }
    const key = String(root.id)
    if (!groups.has(key)) groups.set(key, { root, children: [] })
    if (String(reply.id) !== key) groups.get(key).children.push(reply)
  }
  return [...groups.values()].sort((a, b) => compareReplies(a.root, b.root)).map(group => ({
    ...group,
    children: group.children.sort((a, b) =>
      new Date(a.created_at) - new Date(b.created_at) || Number(a.id) - Number(b.id)),
  }))
}
