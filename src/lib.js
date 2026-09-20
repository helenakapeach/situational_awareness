export const LIMITS = Object.freeze({
  titleMin: 3,
  titleMax: 120,
  postMax: 4000,
  replyMax: 2000,
  feedbackMax: 2000,
})

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

export function withVoteState(reply, liked) {
  return {
    ...reply,
    upvote_count: Math.max(0, Number(reply.upvote_count) || 0),
    liked_by_me: Boolean(liked),
  }
}
