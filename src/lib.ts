import type { MemberRole, Post, Profile, ProfileFormInput, ProfileUpdateRequest, Reply, SessionUser, ValidationResult } from './types.ts'

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

export function normalizeText(value: unknown) {
  return String(value ?? '').trim()
}

export function normalizeInviteCode(value: unknown) {
  return String(value ?? '').trim().toUpperCase()
}

export function normalizePostId(value: unknown) {
  const text = String(value ?? '').trim()
  return /^\d+$/.test(text) && Number(text) > 0 ? text : null
}

export function backendStorageKey(key: string, backendMode: string) {
  return backendMode === 'mongo' ? `${key}:mongo` : key
}

export function postIdFromSearch(search: string = '') {
  return normalizePostId(new URLSearchParams(search).get('post'))
}

export function postUrl(currentUrl: string, postId: string | number | null = null) {
  const url = new URL(currentUrl)
  const normalized = normalizePostId(postId)
  const mongoOptIn = url.searchParams.get('backend') === 'mongo'
  url.hash = ''
  url.search = ''
  if (mongoOptIn) url.searchParams.set('backend', 'mongo')
  if (normalized) url.searchParams.set('post', normalized)
  return url.href
}

export function postShareText(title: unknown, url: string) {
  const normalizedTitle = normalizeText(title).slice(0, LIMITS.titleMax)
  return normalizedTitle ? `${normalizedTitle}\n${url}` : url
}

export function validateInviteCode(value: unknown): ValidationResult<string> {
  const code = normalizeInviteCode(value)
  if (!code) {
    return { ok: false, message: '请输入邀请码。' }
  }
  return { ok: true, value: code }
}

export function validatePost(title: unknown, body: unknown): ValidationResult<{ title: string; body: string }> {
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

export function validateReply(body: unknown, anonymous = false): ValidationResult<{ body: string; is_anonymous: boolean }> {
  const cleanBody = normalizeText(body)

  if (!cleanBody) {
    return { ok: false, message: '回复不能为空。' }
  }
  if (cleanBody.length > LIMITS.replyMax) {
    return { ok: false, message: `回复不能超过 ${LIMITS.replyMax} 个字。` }
  }

  return { ok: true, value: { body: cleanBody, is_anonymous: Boolean(anonymous) } }
}

export function validateFeedback(body: unknown): ValidationResult<{ body: string }> {
  const cleanBody = normalizeText(body)

  if (!cleanBody) {
    return { ok: false, message: '请写下你的反馈。' }
  }
  if (cleanBody.length > LIMITS.feedbackMax) {
    return { ok: false, message: `反馈不能超过 ${LIMITS.feedbackMax} 个字。` }
  }

  return { ok: true, value: { body: cleanBody } }
}

export function formatRelativeTime(input: string | number | Date, now = Date.now()) {
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

export function formatAbsoluteTime(input: string | number | Date) {
  const date = new Date(input)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function safeAvatarUrl(value: unknown) {
  if (!value) return null

  try {
    const url = new URL(String(value))
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function isDataAvatar(text: string) {
  return text.length <= 200_000 && DATA_AVATAR.test(text)
}

export function isUploadedAvatar(value: unknown) {
  const text = String(value ?? '')
  return STORAGE_AVATAR.test(text) || isDataAvatar(text)
}

export function displayAvatarUrl(value: unknown, storageBase = '') {
  const text = String(value ?? '')
  if (STORAGE_AVATAR.test(text)) {
    return storageBase ? safeAvatarUrl(`${storageBase}/storage/v1/object/public/avatars/${text}`) : null
  }
  if (isDataAvatar(text)) return text
  return safeAvatarUrl(text)
}

export function roleLabel(role: string | null, cohortName = '') {
  const label = (ROLES as Readonly<Record<string, string>>)[role ?? '']
  if (!label) return ''
  const cohort = normalizeText(cohortName)
  if (role === 'student' && cohort) return `${label} · ${cohort}`
  return label
}

const ANONYMOUS_PERSONAS = [
  { name: '小水獭', emoji: '🦦' },
  { name: '小狐狸', emoji: '🦊' },
  { name: '小熊猫', emoji: '🐼' },
  { name: '小企鹅', emoji: '🐧' },
  { name: '小考拉', emoji: '🐨' },
  { name: '小兔子', emoji: '🐰' },
  { name: '小浣熊', emoji: '🦝' },
  { name: '小海豚', emoji: '🐬' },
  { name: '小柴犬', emoji: '🐶' },
  { name: '小刺猬', emoji: '🦔' },
  { name: '小树懒', emoji: '🦥' },
  { name: '小羊驼', emoji: '🦙' },
  { name: '小海豹', emoji: '🦭' },
  { name: '小松鼠', emoji: '🐿️' },
  { name: '小仓鼠', emoji: '🐹' },
  { name: '小麋鹿', emoji: '🦌' },
]

function personaIndex(id: string | number) {
  const text = String(id ?? '')
  let hash = 0
  for (const char of text) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0
  return hash % ANONYMOUS_PERSONAS.length
}

export function anonymousPersona(id: string | number) {
  return ANONYMOUS_PERSONAS[personaIndex(id)]
}

// Two different anonymous people in one thread must not share an animal,
// or readers will take them for the same person.
export function assignAnonymousPersonas(ids: readonly (string | number)[]) {
  const used = new Set()
  const assigned = new Map()
  for (const id of ids) {
    if (used.size === ANONYMOUS_PERSONAS.length) used.clear()
    let index = personaIndex(id)
    while (used.has(index)) index = (index + 1) % ANONYMOUS_PERSONAS.length
    used.add(index)
    assigned.set(String(id), ANONYMOUS_PERSONAS[index]!)
  }
  return assigned
}

export function graduationLabel(year: unknown) {
  const value = Number(year)
  if (!Number.isInteger(value) || value < GRADUATION_YEAR_MIN || value > GRADUATION_YEAR_MAX) return ''
  return `${value} 届`
}

const CONTROL_CHARS = /[\u0000-\u001F]/

function fitsLine(text: string, max: number) {
  return !CONTROL_CHARS.test(text) && [...text].length <= max
}

export function validateProfile(input: Partial<ProfileFormInput> | null | undefined): ValidationResult<ProfileUpdateRequest> {
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

  const linkedin = normalizeLinkedInUrl(input?.linkedin_url)
  if (linkedin && !LINKEDIN_URL.test(linkedin)) {
    return { ok: false, message: 'LinkedIn 请填写 www.linkedin.com/in/… 形式的链接。' }
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

  const studentNumber = (value: unknown) => (role === 'student' && value != null && value !== '' ? Number(value) : null)
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
      role: (role || null) as MemberRole | null,
      cohort_id: cohortId,
      graduation_year: graduationYear,
    },
  }
}

export function validLinkedInUrl(value: unknown) {
  return LINKEDIN_URL.test(normalizeText(value))
}

export function normalizeLinkedInUrl(value: unknown) {
  const text = normalizeText(value)
  if (!text) return ''
  return `https://${text.replace(/^https?:\/\//i, '')}`
}

export function linkedInDisplayValue(value: unknown) {
  return normalizeText(value).replace(/^https?:\/\//i, '')
}

export function validContactEmail(value: unknown) {
  return CONTACT_EMAIL.test(normalizeText(value))
}

export function displayName(user: Pick<SessionUser, 'user_metadata'> | null | undefined) {
  return (
    normalizeText(user?.user_metadata?.full_name) ||
    normalizeText(user?.user_metadata?.name) ||
    'Google 用户'
  ).slice(0, 80)
}

export function initials(name: unknown) {
  const cleanName = normalizeText(name)
  if (!cleanName) return '人'

  const chunks = cleanName.split(/\s+/).filter(Boolean)
  if (chunks.length > 1) {
    return `${chunks[0]?.[0] ?? ''}${chunks.at(-1)?.[0] ?? ''}`.toUpperCase()
  }
  return cleanName.slice(0, 2).toUpperCase()
}

export function excerptPlain(source: unknown, max = 48) {
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

export function compareReplies(a: Partial<Reply>, b: Partial<Reply>) {
  const voteDiff = (Number(b?.upvote_count) || 0) - (Number(a?.upvote_count) || 0)
  if (voteDiff !== 0) return voteDiff

  const timeA = new Date(a?.created_at ?? '').getTime()
  const timeB = new Date(b?.created_at ?? '').getTime()
  const safeA = Number.isFinite(timeA) ? timeA : 0
  const safeB = Number.isFinite(timeB) ? timeB : 0
  if (safeA !== safeB) return safeA - safeB

  return (Number(a?.id) || 0) - (Number(b?.id) || 0)
}

export function sortReplies<T extends Pick<Reply, 'id' | 'created_at'> & Partial<Reply>>(replies: T[]) {
  return [...(replies || [])].sort(compareReplies)
}

export function withVoteState<T extends Record<string, unknown>>(item: T, liked: unknown): T & { upvote_count: number; liked_by_me: boolean } {
  return {
    ...item,
    upvote_count: Math.max(0, Number(item.upvote_count) || 0),
    liked_by_me: Boolean(liked),
  }
}

function seenCutoff(lastSeenAt: string | number | Date) {
  const cutoff = typeof lastSeenAt === 'number' ? lastSeenAt : new Date(lastSeenAt).getTime()
  return Number.isFinite(cutoff) ? cutoff : null
}

type ReplyActivity = Partial<Reply>
type PostActivity = Omit<Partial<Post>, 'replies'> & { replies?: ReplyActivity[] }

function participatedIn(post: PostActivity | null | undefined) {
  const replies = Array.isArray(post?.replies) ? post.replies : []
  return Boolean(post?.is_mine) || replies.some((reply) => reply?.is_mine)
}

export function isNewReply(post: PostActivity, reply: Partial<Reply>, lastSeenAt: string | number | Date) {
  const cutoff = seenCutoff(lastSeenAt)
  if (!participatedIn(post) || cutoff === null || reply?.is_mine) return false
  const createdAt = new Date(reply?.created_at ?? '').getTime()
  return Number.isFinite(createdAt) && createdAt > cutoff
}

export function unreadReplyCount(post: PostActivity, lastSeenAt: string | number | Date) {
  if (!participatedIn(post) || seenCutoff(lastSeenAt) === null) return 0
  const replies = Array.isArray(post?.replies) ? post.replies : []
  return replies.filter((reply) => isNewReply(post, reply, lastSeenAt)).length
}

// Same author is not enough: the badge only shows when the reply and the post
// are both anonymous or both named. A mismatch would tie a hidden identity to
// a visible one.
export function replyIsFromOp(postAnonymous: boolean, replyAnonymous: boolean, sameAuthor: boolean) {
  return Boolean(sameAuthor) && Boolean(postAnonymous) === Boolean(replyAnonymous)
}

export function isLateNight(date: Date = new Date()) {
  const hour = date.getHours()
  return hour >= 23 || hour < 5
}

export const MILESTONES = Object.freeze({
  firstAnswer: '你的问题收到了第一个回答。',
  firstGoodQuestion: '第一次有人觉得你问了个好问题。',
  firstReplyUpvote: '你的回答第一次被人点了赞。',
})

// A milestone is someone else noticing you, so the viewer's own vote never counts.
function votesFromOthers(item: Partial<Post> | Partial<Reply>) {
  return Math.max(0, (Number(item?.upvote_count) || 0) - (item?.liked_by_me ? 1 : 0))
}

export function reachedMilestones(posts: PostActivity[]) {
  const reached = new Set()
  for (const post of posts || []) {
    const replies = Array.isArray(post?.replies) ? post.replies : []
    if (post?.is_mine) {
      if (replies.some((reply) => !reply?.is_mine)) reached.add('firstAnswer')
      if (votesFromOthers(post) > 0) reached.add('firstGoodQuestion')
    }
    if (replies.some((reply) => reply?.is_mine && votesFromOthers(reply) > 0)) {
      reached.add('firstReplyUpvote')
    }
  }
  return Object.keys(MILESTONES).filter((key) => reached.has(key))
}

// Root replies keep vote ranking; conversations always read oldest to newest.
export function groupReplyThreads<T extends Pick<Reply, 'id' | 'post_id'> & Partial<Reply>>(replies: T[]) {
  const byId = new Map<string, T>(replies.map(reply => [String(reply.id), reply]))
  const groups = new Map<string, { root: T; children: T[] }>()
  for (const reply of replies) {
    let root = reply
    const visited = new Set([String(root.id)])
    while (root.parent_reply_id != null && byId.has(String(root.parent_reply_id))) {
      const parent = byId.get(String(root.parent_reply_id))!
      if (String(parent.post_id) !== String(reply.post_id) || visited.has(String(parent.id))) break
      visited.add(String(parent.id))
      root = parent
    }
    const key = String(root.id)
    if (!groups.has(key)) groups.set(key, { root, children: [] })
    if (String(reply.id) !== key) groups.get(key)?.children.push(reply)
  }
  return [...groups.values()].sort((a, b) => compareReplies(a.root, b.root)).map(group => ({
    ...group,
    children: group.children.sort((a, b) =>
      new Date(a.created_at ?? '').getTime() - new Date(b.created_at ?? '').getTime() || Number(a.id) - Number(b.id)),
  }))
}
