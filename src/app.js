import './styles.css'
import { createBackend } from './backend.js'
import {
  LIMITS,
  displayAvatarUrl,
  displayName,
  excerptPlain,
  formatRelativeTime,
  groupReplyThreads,
  initials,
  isUploadedAvatar,
  normalizePostId,
  postIdFromSearch,
  postShareText,
  postUrl,
  GRADUATION_YEAR_MAX,
  GRADUATION_YEAR_MIN,
  graduationLabel,
  ROLES,
  roleLabel,
  unreadReplyCount,
  validateFeedback,
  validateInviteCode,
  validatePost,
  validateProfile,
  validateReply,
  validContactEmail,
  validLinkedInUrl,
} from './lib.js'
import { renderMarkdown } from './markdown.js'

const backend = createBackend()
const elements = {
  accountName: document.querySelector('#account-name'),
  app: document.querySelector('#app-view'),
  confirmAccept: document.querySelector('#confirm-accept'),
  confirmBody: document.querySelector('#confirm-body'),
  confirmCancel: document.querySelector('#confirm-cancel'),
  confirmDialog: document.querySelector('#confirm-dialog'),
  confirmTitle: document.querySelector('#confirm-title'),
  demoBanner: document.querySelector('#demo-banner'),
  feed: document.querySelector('#feed'),
  feedHeadingRow: document.querySelector('.feed-heading-row'),
  feedIntro: document.querySelector('#panel-feed > .intro-panel'),
  feedStatus: document.querySelector('#feed-status'),
  feedbackBody: document.querySelector('#feedback-body'),
  feedbackButton: document.querySelector('#feedback-button'),
  feedbackCancel: document.querySelector('#feedback-cancel'),
  feedbackDialog: document.querySelector('#feedback-dialog'),
  feedbackForm: document.querySelector('#feedback-form'),
  inviteCodeInput: document.querySelector('#invite-code-input'),
  inviteError: document.querySelector('#invite-error'),
  inviteForm: document.querySelector('#invite-form'),
  inviteSignoutButton: document.querySelector('#invite-signout-button'),
  inviteView: document.querySelector('#invite-view'),
  loadMoreButton: document.querySelector('#load-more-button'),
  loadMoreRow: document.querySelector('.load-more-row'),
  loading: document.querySelector('#loading-view'),
  login: document.querySelector('#signed-out-view'),
  loginButton: document.querySelector('#login-button'),
  copyLoginLink: document.querySelector('#copy-login-link'),
  copyBrowserLink: document.querySelector('#copy-browser-link'),
  logoutButton: document.querySelector('#logout-button'),
  notificationButton: document.querySelector('#notification-button'),
  notificationCount: document.querySelector('#notification-count'),
  notificationList: document.querySelector('#notification-list'),
  notificationPanel: document.querySelector('#notification-panel'),
  notificationSummary: document.querySelector('#notification-summary'),
  panelLinks: document.querySelectorAll('.panel-link'),
  panels: document.querySelectorAll('.panel'),
  composerFields: document.querySelector('#composer-fields'),
  composerHint: document.querySelector('#composer-hint'),
  composerToggle: document.querySelector('#composer-toggle'),
  composerToggleLabel: document.querySelector('#composer-toggle-label'),
  postAnonymous: document.querySelector('#post-anonymous'),
  postBody: document.querySelector('#post-body'),
  postCharacterCount: document.querySelector('#post-character-count'),
  postForm: document.querySelector('#post-form'),
  postIdentity: document.querySelector('#post-identity'),
  postTitle: document.querySelector('#post-title'),
  refreshButton: document.querySelector('#refresh-button'),
  searchInput: document.querySelector('#search-input'),
  themeToggles: document.querySelectorAll('.theme-toggle'),
  toast: document.querySelector('#toast'),
  wechatBrowserNotice: document.querySelector('#wechat-browser-notice'),
}

const THEME_KEY = 'situational-awareness-theme'
const TARGET_POST_KEY = 'situational-awareness-target-post'
const UNREAD_BASELINE_KEY = 'situational-awareness-unread-baseline'
const POST_SEEN_KEY = 'situational-awareness-post-seen'
const BASE_DOCUMENT_TITLE = document.title

let isAdmin = false
let session = null
let ownProfile = null
let cohorts = []
let profileError = ''
let loadingPosts = false
let toastTimer = null
let searchTimer = null
// 搜索只筛已经取回的这批帖子，不再打一次后端
let cachedPosts = []
let hasMorePosts = false
let searchQuery = ''
let unreadTrackingUserId = null
let unreadBaselineAt = Date.now()
let postSeenAt = {}

function userStorageKey(key) {
  return `${key}:${session?.user?.id || 'signed-out'}`
}

function initializeUnreadTracking() {
  const userId = String(session?.user?.id || '')
  if (!userId || unreadTrackingUserId === userId) return

  unreadTrackingUserId = userId
  unreadBaselineAt = Date.now()
  postSeenAt = {}
  try {
    const savedBaseline = Number(window.localStorage.getItem(userStorageKey(UNREAD_BASELINE_KEY)))
    if (Number.isFinite(savedBaseline) && savedBaseline > 0) {
      unreadBaselineAt = savedBaseline
    } else {
      window.localStorage.setItem(userStorageKey(UNREAD_BASELINE_KEY), String(unreadBaselineAt))
    }

    const savedSeen = JSON.parse(window.localStorage.getItem(userStorageKey(POST_SEEN_KEY)) || '{}')
    if (savedSeen && typeof savedSeen === 'object' && !Array.isArray(savedSeen)) {
      postSeenAt = Object.fromEntries(
        Object.entries(savedSeen).filter(([, value]) => Number.isFinite(Number(value))),
      )
    }
  } catch {
    // 无痕模式或损坏的本地数据只会让未读提示从本次访问重新开始。
  }
}

function lastSeenAt(postId) {
  return Number(postSeenAt[String(postId)]) || unreadBaselineAt
}

function markPostSeen(postId) {
  const normalized = normalizePostId(postId)
  if (!normalized) return
  initializeUnreadTracking()
  postSeenAt[normalized] = Date.now()
  try {
    window.localStorage.setItem(userStorageKey(POST_SEEN_KEY), JSON.stringify(postSeenAt))
  } catch {
    // 当前页面仍会正确清掉提示；只是下次访问无法保留。
  }
  renderNotifications()
}

function unreadPosts() {
  return cachedPosts
    .map((post) => ({ post, count: unreadReplyCount(post, lastSeenAt(post.id)) }))
    .filter(({ count }) => count > 0)
}

function closeNotifications() {
  elements.notificationPanel.hidden = true
  elements.notificationButton.setAttribute('aria-expanded', 'false')
}

function renderNotifications() {
  if (!session || !elements.notificationList) return

  const entries = unreadPosts()
  const total = entries.reduce((sum, entry) => sum + entry.count, 0)
  elements.notificationCount.hidden = total === 0
  elements.notificationCount.textContent = total > 99 ? '99+' : String(total)
  elements.notificationButton.setAttribute(
    'aria-label',
    total ? `${total} 条新回复` : '没有新回复',
  )
  elements.notificationSummary.textContent = total ? `共 ${total} 条` : '暂时没有'
  elements.notificationList.replaceChildren()

  if (!entries.length) {
    elements.notificationList.append(
      element('p', 'notification-empty', '你参与的讨论有新回复时，会出现在这里。'),
    )
    return
  }

  entries.forEach(({ post, count }) => {
    const link = element('a', 'notification-item')
    link.href = postUrl(window.location.href, post.id)
    link.append(
      element('span', 'notification-title', post.title),
      element('strong', 'notification-reply-count', `${count} 条新回复`),
    )
    link.addEventListener('click', (event) => {
      event.preventDefault()
      markPostSeen(post.id)
      rememberTargetPost(post.id)
      closeNotifications()
      window.location.assign(link.href)
    })
    elements.notificationList.append(link)
  })
}

function storedTargetPostId() {
  try {
    return normalizePostId(window.localStorage.getItem(TARGET_POST_KEY))
  } catch {
    return null
  }
}

function targetPostId() {
  return postIdFromSearch(window.location.search) || storedTargetPostId()
}

function rememberTargetPost(postId) {
  const normalized = normalizePostId(postId)
  if (!normalized) return
  try {
    window.localStorage.setItem(TARGET_POST_KEY, normalized)
  } catch {
    // URL 本身仍然是主路径；本地存储只是 OAuth 回跳丢参数时的保险。
  }
}

function restoreTargetPostUrl() {
  const fromUrl = postIdFromSearch(window.location.search)
  if (fromUrl) {
    rememberTargetPost(fromUrl)
    return fromUrl
  }

  const stored = storedTargetPostId()
  if (stored) window.history.replaceState(null, '', postUrl(window.location.href, stored))
  return stored
}

function setTargetPostUrl(postId) {
  const normalized = normalizePostId(postId)
  if (normalized) rememberTargetPost(normalized)
  else clearStoredTargetPost()
  window.history.replaceState(null, '', postUrl(window.location.href, normalized))
}

function clearStoredTargetPost() {
  try {
    window.localStorage.removeItem(TARGET_POST_KEY)
  } catch {
    // URL 已经足够维持当前页面状态。
  }
}

function isWechatBrowser() {
  return /MicroMessenger/i.test(window.navigator.userAgent)
}

// 回复框和编辑框都是 renderFeed 现搭的，任何一次重绘都会把它们连同里面
// 没提交的字一起扔掉。草稿存在 DOM 之外，重绘后再填回去。
const replyDrafts = new Map()
const collapsedReplyThreads = new Set()
const editDrafts = new Map()
const postEditDrafts = new Map()

function showPanel(name) {
  elements.panels.forEach((panel) => {
    panel.hidden = panel.id !== `panel-${name}`
  })
  elements.panelLinks.forEach((link) => {
    if (link.dataset.panel === name) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
}

function setView(view) {
  elements.loading.hidden = view !== 'loading'
  elements.login.hidden = view !== 'login'
  elements.inviteView.hidden = view !== 'invite'
  elements.app.hidden = view !== 'app'
}

function activeTheme() {
  const forced = document.documentElement.dataset.theme
  if (forced === 'light' || forced === 'dark') return forced
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function toggleTheme() {
  const next = activeTheme() === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  try {
    window.localStorage.setItem(THEME_KEY, next)
  } catch {
    // 无痕模式下写不进去，本次会话内的切换仍然生效
  }
}

function setButtonBusy(button, busy, busyText) {
  const label = button.querySelector('span') || button
  if (busy) {
    button.dataset.label = label.textContent
    label.textContent = busyText
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
  } else {
    label.textContent = button.dataset.label || label.textContent
    button.disabled = false
    button.removeAttribute('aria-busy')
  }
}

function showToast(message, kind = 'normal') {
  window.clearTimeout(toastTimer)
  elements.toast.textContent = message
  elements.toast.dataset.kind = kind
  elements.toast.classList.add('show')
  toastTimer = window.setTimeout(() => elements.toast.classList.remove('show'), 3200)
}

function friendlyError(error) {
  const message = String(error?.message || error || '')
  if (/not_authenticated/i.test(message)) {
    return '登录状态已失效，请重新登录后再试。'
  }
  if (/row-level security|permission denied|42501/i.test(message)) {
    return '当前账号没有操作权限。请确认使用 Google 登录并已应用数据库脚本。'
  }
  if (/failed to fetch|network/i.test(message)) {
    return '网络连接失败，请稍后重试。'
  }
  return message || '操作失败，请稍后重试。'
}

// 长度上限只在 LIMITS 里定义一次，输入框的 maxlength 由这里贴上去，
// 免得 HTML 和校验逻辑各写一个数字然后慢慢对不上。
function applyLimits() {
  elements.postTitle.minLength = LIMITS.titleMin
  elements.postTitle.maxLength = LIMITS.titleMax
  elements.postBody.maxLength = LIMITS.postMax
  elements.feedbackBody.maxLength = LIMITS.feedbackMax
}

function attachCharacterCount(field, counter, max) {
  const render = () => {
    counter.textContent = `${field.value.length} / ${max}`
  }
  field.addEventListener('input', render)
  render()
  return render
}

function confirmAction({ title, body, confirmLabel }) {
  elements.confirmTitle.textContent = title
  elements.confirmBody.textContent = body
  elements.confirmAccept.textContent = confirmLabel
  // Esc 关闭时 returnValue 保持不变，所以先摆一个非 confirm 的值
  elements.confirmDialog.returnValue = 'cancel'
  elements.confirmDialog.showModal()

  return new Promise((resolve) => {
    elements.confirmDialog.addEventListener(
      'close',
      () => resolve(elements.confirmDialog.returnValue === 'confirm'),
      { once: true },
    )
  })
}

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function makeMarkdownBody(className, source) {
  const body = element('div', `${className} markdown-body`)
  try {
    body.innerHTML = renderMarkdown(source)
  } catch {
    body.textContent = String(source ?? '')
  }
  return body
}

function makeAvatar(name, avatarUrl, anonymous = false, onOpen = null) {
  const wrapper = element(onOpen ? 'button' : 'div', anonymous ? 'avatar anonymous' : 'avatar')
  if (onOpen) {
    wrapper.type = 'button'
    wrapper.setAttribute('aria-label', `查看${name || '成员'}的主页`)
    wrapper.addEventListener('click', onOpen)
  } else {
    wrapper.setAttribute('aria-hidden', 'true')
  }

  if (anonymous) {
    wrapper.textContent = '?'
    return wrapper
  }

  const safeUrl = displayAvatarUrl(avatarUrl, backend.storageBase)
  if (safeUrl) {
    const image = document.createElement('img')
    image.src = safeUrl
    image.alt = ''
    image.referrerPolicy = 'no-referrer'
    wrapper.append(image)
  } else {
    wrapper.textContent = initials(name)
  }
  return wrapper
}

function makeReply(reply, { highlighted = false, replyMap = new Map() } = {}) {
  const draftKey = String(reply.id)
  const anonymous = Boolean(reply.is_anonymous)
  const item = element('li', highlighted ? 'reply is-insight' : 'reply')
  item.id = `comment-${reply.id}`
  item.append(makeAvatar(
    reply.author_name,
    reply.author_avatar_url,
    anonymous,
    linkableProfile(reply, anonymous),
  ))

  const content = element('div', 'reply-content')
  const who = element('div')
  who.append(makeAuthorName(reply.author_name, reply.author_public_id, anonymous, 'reply-name'))
  const byline = element('div', 'reply-byline')
  byline.append(element('time', 'reply-time', formatRelativeTime(reply.created_at)))
  const replyRole = anonymous ? null : makeRoleTag(reply.author_role, reply.author_cohort_name, reply.author_role_verified)
  if (replyRole) byline.append(replyRole)
  if (reply.updated_at) byline.append(element('span', 'reply-edited', '已编辑'))
  who.append(byline)

  const body = makeMarkdownBody('reply-body', reply.body)
  const respond = element('button', 'text-button', '回复')
  respond.type = 'button'
  respond.setAttribute('aria-label', `回复这条评论：${excerptPlain(reply.body, 25)}`)
  const toolbar = makeReplyToolbar(reply, {
    onEdit: () => enterEdit(),
    respond,
  })

  content.append(who)
  const parent = replyMap.get(String(reply.parent_reply_id))
  if (parent) {
    const context = element('a', 'reply-context', `回复 ${parent.is_anonymous ? '匿名成员' : parent.author_name || 'Google 用户'}：${excerptPlain(parent.body, 42)}`)
    context.href = `#comment-${parent.id}`
    context.addEventListener('click', event => {
      event.preventDefault()
      const target = document.getElementById(`comment-${parent.id}`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target?.focus({ preventScroll: true })
    })
    content.append(context)
  }
  item.tabIndex = -1
  content.append(body, toolbar)
  const responseKey = `${reply.post_id}:${reply.id}`
  function openResponse(focus = true) {
    let form = content.querySelector(':scope > .nested-reply-form')
    if (!form) {
      form = makeReplyForm(reply.post_id, reply)
      content.append(form)
    }
    if (focus) form.querySelector('textarea').focus()
  }
  respond.addEventListener('click', () => openResponse())
  if (replyDrafts.has(responseKey)) openResponse(false)
  item.append(content)

  function showView() {
    editDrafts.delete(draftKey)
    body.hidden = false
    toolbar.hidden = false
    content.querySelector(':scope > .reply-edit-form')?.remove()
  }

  function enterEdit({ focus = true } = {}) {
    if (content.querySelector(':scope > .reply-edit-form')) return

    body.hidden = true
    toolbar.hidden = true

    const form = element('form', 'reply-form reply-edit-form')
    const label = element('label', 'sr-only', '编辑回复')
    const textarea = document.createElement('textarea')
    const actions = element('div', 'reply-actions')
    const count = element('span', 'character-count')
    const cancel = element('button', 'text-button', '取消')
    const save = element('button', 'secondary-button', '保存')

    label.htmlFor = `edit-reply-${reply.id}`
    textarea.id = `edit-reply-${reply.id}`
    textarea.name = 'body'
    textarea.rows = 4
    textarea.maxLength = LIMITS.replyMax
    textarea.value = editDrafts.get(draftKey) ?? reply.body
    textarea.required = true
    cancel.type = 'button'
    save.type = 'submit'

    attachCharacterCount(textarea, count, LIMITS.replyMax)
    textarea.addEventListener('input', () => editDrafts.set(draftKey, textarea.value))
    cancel.addEventListener('click', showView)
    actions.append(count, cancel, save)
    form.append(label, textarea, actions)

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const result = validateReply(textarea.value, reply.is_anonymous)
      if (!result.ok) {
        showToast(result.message, 'error')
        textarea.focus()
        return
      }

      setButtonBusy(save, true, '保存中…')
      try {
        await backend.updateReply(reply.id, result.value.body)
        editDrafts.delete(draftKey)
        await loadPosts({ preserveOpenPost: String(reply.post_id) })
        showToast('回复已更新。')
      } catch (error) {
        showToast(friendlyError(error), 'error')
        setButtonBusy(save, false)
      }
    })

    content.append(form)
    if (focus) {
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    }
  }

  // 重绘之前正在编辑的，重绘之后接着编辑。这里别抢焦点：重绘可能是
  // 别处触发的，把页面滚到这条回复上会很突兀。
  if (editDrafts.has(draftKey)) enterEdit({ focus: false })

  return item
}

function makeReplyToolbar(reply, { onEdit, respond }) {
  const toolbar = element('div', 'reply-toolbar')
  const end = element('div', 'reply-end')
  toolbar.append(makeReplyVoteButton(reply), end)
  end.append(respond)

  if (!reply.is_mine && !isAdmin) return toolbar

  const own = element('div', 'reply-own-actions')
  const edit = element('button', 'text-button', '编辑')
  const remove = element('button', 'text-button danger', '删除')
  edit.type = 'button'
  remove.type = 'button'
  edit.addEventListener('click', onEdit)
  remove.addEventListener('click', async () => {
    const confirmed = await confirmAction({
      title: '删除这条回复？',
      body: '这条评论和它的赞会删除，其他人的回复会保留。',
      confirmLabel: '删除',
    })
    if (!confirmed) return

    setButtonBusy(remove, true, '删除中…')
    try {
      if (isAdmin) await backend.adminDeleteContent(reply.id, 'reply')
      else await backend.deleteReply(reply.id)
      editDrafts.delete(String(reply.id))
      replyDrafts.delete(`${reply.post_id}:${reply.id}`)
      await loadPosts({ preserveOpenPost: String(reply.post_id) })
      showToast('回复已删除。')
    } catch (error) {
      showToast(friendlyError(error), 'error')
      setButtonBusy(remove, false)
    }
  })
  if (reply.is_mine) own.append(edit)
  own.append(remove)
  end.prepend(own)
  return toolbar
}

function currentDisplayName() {
  return ownProfile?.display_name || displayName(session?.user)
}

function replyIdentityText(anonymous) {
  return anonymous
    ? '将以匿名身份回复'
    : `将以 ${currentDisplayName()} 的名义回复`
}

function postIdentityText(anonymous) {
  return anonymous
    ? '将以匿名身份发布'
    : `将以 ${currentDisplayName()} 的名义发布`
}

function makeThumbsUpIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML =
    '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>'
  return svg
}

function rememberVote(target, liked, count) {
  cachedPosts = cachedPosts.map((post) => {
    if (target.postId != null && String(post.id) === String(target.postId)) {
      return { ...post, liked_by_me: liked, upvote_count: count }
    }
    if (target.replyId != null) {
      return {
        ...post,
        replies: post.replies.map((reply) =>
          String(reply.id) === String(target.replyId)
            ? { ...reply, liked_by_me: liked, upvote_count: count }
            : reply,
        ),
      }
    }
    return post
  })
}

function makeVoteButton({ likedByMe, upvoteCount, onToggle, remember, question = false }) {
  let liked = Boolean(likedByMe)
  let count = Math.max(0, Number(upvoteCount) || 0)
  const button = document.createElement('button')
  const countLabel = element('span', 'vote-count', String(count))
  button.type = 'button'
  button.className = question ? 'vote-button is-question' : 'vote-button'
  button.append(makeThumbsUpIcon(), countLabel)

  function render() {
    button.setAttribute('aria-pressed', liked ? 'true' : 'false')
    button.setAttribute(
      'aria-label',
      question
        ? liked
          ? `取消「好问题」，当前 ${count} 人觉得这是好问题`
          : `认为这是好问题，当前 ${count} 人觉得这是好问题`
        : liked
          ? `取消点赞，当前 ${count} 人点赞`
          : `点赞，当前 ${count} 人点赞`,
    )
    countLabel.textContent = String(count)
  }
  render()

  button.addEventListener('click', async () => {
    if (button.disabled) return
    button.disabled = true
    const previousLiked = liked
    const previousCount = count
    liked = !liked
    count = Math.max(0, count + (liked ? 1 : -1))
    render()

    try {
      await onToggle()
      remember(liked, count)
    } catch (error) {
      liked = previousLiked
      count = previousCount
      render()
      showToast(friendlyError(error), 'error')
    } finally {
      button.disabled = false
    }
  })

  return button
}

function makePostVoteButton(post) {
  return makeVoteButton({
    likedByMe: post.liked_by_me,
    upvoteCount: post.upvote_count,
    question: true,
    onToggle: () => backend.togglePostVote(post.id),
    remember: (liked, count) => rememberVote({ postId: post.id }, liked, count),
  })
}

function makeReplyVoteButton(reply) {
  return makeVoteButton({
    likedByMe: reply.liked_by_me,
    upvoteCount: reply.upvote_count,
    onToggle: () => backend.toggleReplyVote(reply.id),
    remember: (liked, count) => rememberVote({ replyId: reply.id }, liked, count),
  })
}

function makeReplyForm(postId, target = null) {
  const draftKey = target ? `${postId}:${target.id}` : String(postId)
  const draft = replyDrafts.get(draftKey)
  const form = element('form', target ? 'reply-form nested-reply-form' : 'reply-form')
  const label = element('label', 'sr-only', '写下你的回复')
  const textarea = document.createElement('textarea')
  const actions = element('div', 'reply-actions')
  const meta = element('div', 'reply-meta')
  const count = element('span', 'character-count')
  const anonymousLabel = element('label', 'checkbox-line')
  const anonymousInput = document.createElement('input')
  const identity = element('span', 'reply-identity')
  const button = element('button', 'secondary-button', '发布回复')

  label.htmlFor = `reply-${draftKey}`
  textarea.id = `reply-${draftKey}`
  textarea.name = 'reply'
  textarea.rows = 3
  textarea.maxLength = LIMITS.replyMax
  textarea.placeholder = '分享你的判断、经历或一个值得追问的问题…'
  textarea.required = true
  textarea.value = draft?.body || ''

  anonymousInput.type = 'checkbox'
  anonymousInput.name = 'anonymous'
  anonymousInput.checked = draft?.anonymous ?? Boolean(target?.is_anonymous)
  anonymousLabel.append(anonymousInput, document.createTextNode('匿名回复'))
  identity.id = `reply-identity-${draftKey}`
  identity.textContent = replyIdentityText(anonymousInput.checked)
  anonymousInput.setAttribute('aria-describedby', identity.id)

  function rememberDraft() {
    if (textarea.value || anonymousInput.checked) {
      replyDrafts.set(draftKey, { body: textarea.value, anonymous: anonymousInput.checked })
    } else {
      replyDrafts.delete(draftKey)
    }
  }

  attachCharacterCount(textarea, count, LIMITS.replyMax)
  textarea.addEventListener('input', rememberDraft)
  anonymousInput.addEventListener('change', () => {
    identity.textContent = replyIdentityText(anonymousInput.checked)
    rememberDraft()
  })

  button.type = 'submit'

  meta.append(anonymousLabel, identity)
  actions.append(meta, count, button)
  if (target) {
    form.append(element('p', 'reply-target', `回复：${excerptPlain(target.body, 45)}`))
    const cancel = element('button', 'text-button', '取消')
    cancel.type = 'button'
    cancel.addEventListener('click', () => {
      replyDrafts.delete(draftKey)
      form.remove()
    })
    actions.insertBefore(cancel, button)
  }
  form.append(label, textarea, actions)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const result = validateReply(textarea.value, anonymousInput.checked)
    if (!result.ok) {
      showToast(result.message, 'error')
      textarea.focus()
      return
    }

    setButtonBusy(button, true, '发布中…')
    try {
      await backend.createReply(postId, { ...result.value, parent_reply_id: target?.id ?? null })
      markPostSeen(postId)
      textarea.value = ''
      replyDrafts.delete(draftKey)
      await loadPosts({ preserveOpenPost: String(postId) })
      showToast(result.value.is_anonymous ? '已匿名回复。' : '回复已发布。')
    } catch (error) {
      showToast(friendlyError(error), 'error')
    } finally {
      setButtonBusy(button, false)
    }
  })

  return form
}

function namedRepliers(replies, limit = 4) {
  const seen = new Set()
  const faces = []
  for (const reply of replies) {
    if (reply.is_anonymous) continue
    const name = String(reply.author_name || '').trim()
    const key = `${name}|${reply.author_avatar_url || ''}`
    if (!name || seen.has(key)) continue
    seen.add(key)
    faces.push(reply)
    if (faces.length >= limit) break
  }
  return faces
}

function makeInsightPreview(reply) {
  const preview = element('div', 'insight-preview')
  const who = reply.is_anonymous ? '匿名成员' : reply.author_name || '成员'
  const byline = element('span', 'insight-preview-who')
  byline.append(element('span', 'insight-preview-mark', '高赞'), element('span', '', who))
  const insightRole = reply.is_anonymous
    ? null
    : makeRoleTag(reply.author_role, reply.author_cohort_name, reply.author_role_verified)
  if (insightRole) byline.append(insightRole)
  preview.append(byline, element('p', 'insight-preview-body', excerptPlain(reply.body, 160)))
  return preview
}

function bodyMoreButton(body) {
  const next = body.nextElementSibling
  return next?.classList.contains('body-more') ? next : null
}

function setupCollapsibleBody(body, attempts = 0) {
  if (body.dataset.collapseReady || body.hidden) return
  if (!body.isConnected) {
    if (attempts < 4) requestAnimationFrame(() => setupCollapsibleBody(body, attempts + 1))
    return
  }

  body.dataset.collapseReady = '1'
  body.classList.add('is-collapsed')
  if (body.scrollHeight <= body.clientHeight + 4) {
    body.classList.remove('is-collapsed')
    return
  }

  const more = element('button', 'text-button body-more', '全文')
  more.type = 'button'
  more.setAttribute('aria-expanded', 'false')
  more.addEventListener('click', () => {
    const collapsed = body.classList.toggle('is-collapsed')
    more.textContent = collapsed ? '全文' : '收起'
    more.setAttribute('aria-expanded', String(!collapsed))
  })
  body.after(more)
}

function forgetPostDrafts(post) {
  postEditDrafts.delete(String(post.id))
  for (const key of replyDrafts.keys()) {
    if (key === String(post.id) || key.startsWith(`${post.id}:`)) replyDrafts.delete(key)
  }
  for (const reply of post.replies) editDrafts.delete(String(reply.id))
}

function makePost(post, shouldOpen = false, { detail = false } = {}) {
  const article = element('article', 'post-card')
  article.id = `post-${post.id}`
  const draftKey = String(post.id)
  const anonymous = Boolean(post.is_anonymous)

  const header = element('header', 'post-header')
  header.append(makeAvatar(
    post.author_name,
    post.author_avatar_url,
    anonymous,
    linkableProfile(post, anonymous),
  ))
  const meta = element('div', 'post-meta')
  meta.append(
    makeAuthorName(post.author_name, post.author_public_id, anonymous, 'post-author'),
    element('time', 'post-time', formatRelativeTime(post.created_at)),
  )
  const postRole = anonymous ? null : makeRoleTag(post.author_role, post.author_cohort_name, post.author_role_verified)
  if (postRole) meta.append(postRole)
  if (post.updated_at) {
    meta.append(element('span', 'reply-edited', '已编辑'))
  }
  header.append(meta)

  const heading = element('div', 'post-heading')
  const title = element('h3', 'post-title')
  if (detail) {
    title.textContent = post.title
  } else {
    const titleLink = element('a', 'post-title-link', post.title)
    titleLink.href = postUrl(window.location.href, post.id)
    titleLink.addEventListener('click', () => {
      markPostSeen(post.id)
      rememberTargetPost(post.id)
    })
    title.append(titleLink)
  }
  heading.append(title, makePostVoteButton(post))
  const body = makeMarkdownBody('post-body', post.body)

  // 有草稿却折叠起来，等于把它藏没了
  const hasDraft =
    replyDrafts.has(draftKey) || post.replies.some((reply) =>
      editDrafts.has(String(reply.id)) || replyDrafts.has(`${post.id}:${reply.id}`))

  const open = detail || shouldOpen || hasDraft
  const toggle = element('button', 'thread-toggle')
  toggle.type = 'button'
  toggle.setAttribute('aria-expanded', String(open))
  toggle.setAttribute('aria-controls', `thread-${post.id}`)
  const faces = namedRepliers(post.replies)
  if (faces.length) {
    const stack = element('span', 'post-faces')
    faces.forEach((reply) => {
      stack.append(makeAvatar(reply.author_name, reply.author_avatar_url, false))
    })
    toggle.append(stack)
  }
  toggle.append(
    element(
      'span',
      'thread-count',
      post.replies.length ? `${post.replies.length} 条回复` : '还没有回复',
    ),
  )
  if (open) markPostSeen(post.id)
  const newReplyCount = unreadReplyCount(post, lastSeenAt(post.id))
  const unreadBadge = newReplyCount
    ? element('span', 'new-replies-badge', `${newReplyCount} 条新回复`)
    : null
  if (unreadBadge) toggle.append(unreadBadge)

  const replies = element('ol', 'reply-list')
  if (post.replies.length) {
    const replyMap = new Map(post.replies.map(reply => [String(reply.id), reply]))
    groupReplyThreads(post.replies).forEach(({ root, children }, index) => {
      const highlighted = index === 0 && Number(root.upvote_count) > 0
      const item = makeReply(root, { highlighted, replyMap })
      if (children.length) {
        const conversation = element('details', 'reply-conversation')
        const key = String(root.id)
        conversation.open = !collapsedReplyThreads.has(key) || children.some(reply =>
          replyDrafts.has(`${post.id}:${reply.id}`) || editDrafts.has(String(reply.id)))
        const summary = element('summary', 'reply-conversation-toggle', `${children.length} 条跟帖`)
        const nested = element('ol', 'nested-replies')
        children.forEach(reply => nested.append(makeReply(reply, { replyMap })))
        conversation.append(summary, nested)
        conversation.addEventListener('toggle', () => {
          if (conversation.open) collapsedReplyThreads.delete(key)
          else collapsedReplyThreads.add(key)
        })
        item.querySelector('.reply-content').append(conversation)
      }
      replies.append(item)
    })
  } else {
    replies.append(element('li', 'empty-replies', '还没有人回。你的判断可能就是楼主最需要的。'))
  }

  const panel = element('div', 'thread-panel')
  panel.id = `thread-${post.id}`
  panel.dataset.postId = String(post.id)
  panel.hidden = !open
  panel.append(replies, makeReplyForm(post.id))

  toggle.addEventListener('click', () => {
    const isOpen = toggle.getAttribute('aria-expanded') === 'true'
    toggle.setAttribute('aria-expanded', String(!isOpen))
    panel.hidden = isOpen
    if (!isOpen) {
      markPostSeen(post.id)
      unreadBadge?.remove()
    }
  })

  const share = element('button', 'text-button post-share', '复制链接')
  share.type = 'button'
  share.setAttribute('aria-label', `复制讨论链接：${post.title}`)
  share.addEventListener('click', async () => {
    const url = postUrl(window.location.href, post.id)
    try {
      await navigator.clipboard.writeText(postShareText(post.title, url))
      showToast('帖子标题和链接已复制，请粘贴到微信。')
    } catch {
      showToast('复制失败，请从浏览器地址栏复制完整链接。', 'error')
    }
  })

  const topReply = post.replies[0]
  const insight = topReply && Number(topReply.upvote_count) > 0 ? topReply : null
  const insightEl = insight ? makeInsightPreview(insight) : null
  const engage = element('div', 'post-engage')
  if (detail) engage.append(share)
  else engage.append(toggle, share)
  article.append(header, heading, body)
  if (insightEl && !detail) article.append(insightEl)
  article.append(engage, panel)

  function showView() {
    postEditDrafts.delete(draftKey)
    heading.hidden = false
    body.hidden = false
    if (insightEl) insightEl.hidden = false
    const more = bodyMoreButton(body)
    if (more) more.hidden = false
    article.querySelector('.post-edit')?.remove()
    if (!detail) requestAnimationFrame(() => setupCollapsibleBody(body))
  }

  function enterEdit({ focus = true } = {}) {
    if (article.querySelector('.post-edit')) return

    heading.hidden = true
    body.hidden = true
    if (insightEl) insightEl.hidden = true
    const more = bodyMoreButton(body)
    if (more) more.hidden = true

    const draft = postEditDrafts.get(draftKey)
    const form = element('form', 'post-edit')
    const titleLabel = element('label', '', '一句话标题')
    const titleInput = document.createElement('input')
    const bodyLabel = element('label', '', '具体发生了什么？')
    const textarea = document.createElement('textarea')
    const actions = element('div', 'composer-actions')
    const count = element('span', 'character-count')
    const cancel = element('button', 'text-button', '取消')
    const save = element('button', 'secondary-button', '保存')

    titleLabel.htmlFor = `edit-post-title-${post.id}`
    titleInput.id = `edit-post-title-${post.id}`
    titleInput.name = 'title'
    titleInput.type = 'text'
    titleInput.autocomplete = 'off'
    titleInput.required = true
    titleInput.minLength = LIMITS.titleMin
    titleInput.maxLength = LIMITS.titleMax
    titleInput.value = draft?.title ?? post.title

    bodyLabel.htmlFor = `edit-post-body-${post.id}`
    textarea.id = `edit-post-body-${post.id}`
    textarea.name = 'body'
    textarea.rows = 4
    textarea.required = true
    textarea.maxLength = LIMITS.postMax
    textarea.value = draft?.body ?? post.body

    cancel.type = 'button'
    save.type = 'submit'

    function rememberDraft() {
      postEditDrafts.set(draftKey, { title: titleInput.value, body: textarea.value })
    }

    attachCharacterCount(textarea, count, LIMITS.postMax)
    titleInput.addEventListener('input', rememberDraft)
    textarea.addEventListener('input', rememberDraft)
    rememberDraft()
    cancel.addEventListener('click', showView)
    actions.append(count, cancel, save)
    form.append(titleLabel, titleInput, bodyLabel, textarea, actions)

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const result = validatePost(titleInput.value, textarea.value)
      if (!result.ok) {
        showToast(result.message, 'error')
        titleInput.focus()
        return
      }

      setButtonBusy(save, true, '保存中…')
      try {
        await backend.updatePost(post.id, result.value)
        postEditDrafts.delete(draftKey)
        await loadPosts({ preserveOpenPost: draftKey })
        showToast('讨论已更新。')
      } catch (error) {
        showToast(friendlyError(error), 'error')
        setButtonBusy(save, false)
      }
    })

    heading.after(form)
    if (focus) {
      titleInput.focus()
      titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length)
    }
  }

  if (post.is_mine || isAdmin) {
    const own = element('div', 'post-own-actions')
    const edit = element('button', 'text-button', '编辑')
    const remove = element('button', 'text-button danger', '删除')
    edit.type = 'button'
    remove.type = 'button'
    edit.addEventListener('click', () => enterEdit())
    remove.addEventListener('click', async () => {
      const confirmed = await confirmAction({
        title: '删除这条讨论？',
        body: '回复和赞也会一起去掉，删掉之后没法恢复。',
        confirmLabel: '删除',
      })
      if (!confirmed) return

      setButtonBusy(remove, true, '删除中…')
      try {
        if (isAdmin) await backend.adminDeleteContent(post.id, 'post')
        else await backend.deletePost(post.id)
        forgetPostDrafts(post)
        if (targetPostId() === String(post.id)) setTargetPostUrl(null)
        await loadPosts()
        showToast('讨论已删除。')
      } catch (error) {
        showToast(friendlyError(error), 'error')
        setButtonBusy(remove, false)
      }
    })
    if (post.is_mine) own.append(edit)
    own.append(remove)
    header.append(own)
  }

  if (postEditDrafts.has(draftKey)) enterEdit({ focus: false })
  if (!detail) requestAnimationFrame(() => setupCollapsibleBody(body))
  return article
}

function openPostIds() {
  return new Set(
    [...elements.feed.querySelectorAll('.thread-panel[data-post-id]:not([hidden])')].map(
      (panel) => panel.dataset.postId,
    ),
  )
}

function renderFeed(previouslyOpen = new Set()) {
  const requestedPost = targetPostId()
  const detailPost = requestedPost
    ? cachedPosts.find((post) => String(post.id) === requestedPost)
    : null

  elements.feedIntro.hidden = Boolean(requestedPost)
  elements.postForm.hidden = Boolean(requestedPost)
  elements.feedHeadingRow.hidden = Boolean(requestedPost)
  elements.loadMoreRow.hidden = Boolean(requestedPost)
  document.title = detailPost ? `${detailPost.title} · 知局` : BASE_DOCUMENT_TITLE
  renderNotifications()

  if (requestedPost && detailPost) {
    markPostSeen(detailPost.id)
    const detailNav = element('nav', 'post-detail-nav')
    const back = element('a', 'text-button post-detail-back', '← 返回讨论广场')
    back.href = postUrl(window.location.href)
    back.addEventListener('click', () => clearStoredTargetPost())
    detailNav.append(back)
    elements.feed.replaceChildren(detailNav, makePost(detailPost, true, { detail: true }))
    elements.loadMoreButton.hidden = true
    return
  }

  if (requestedPost) {
    const missing = element('div', 'panel-placeholder')
    const back = element('a', 'text-button post-detail-back', '← 返回讨论广场')
    back.href = postUrl(window.location.href)
    back.addEventListener('click', () => clearStoredTargetPost())
    missing.append(
      element('strong', '', '没有找到这条讨论。'),
      element('p', '', '它可能已被删除，或者你暂时没有查看权限。'),
      back,
    )
    elements.feed.replaceChildren(missing)
    elements.loadMoreButton.hidden = true
    return
  }

  const query = searchQuery.trim().toLowerCase()
  const visible = query
    ? cachedPosts.filter(
        (post) =>
          post.title.toLowerCase().includes(query) || post.body.toLowerCase().includes(query),
      )
    : cachedPosts

  elements.feed.replaceChildren()
  elements.loadMoreButton.hidden = !hasMorePosts

  if (visible.length) {
    visible.forEach((post) =>
      elements.feed.append(makePost(post, previouslyOpen.has(String(post.id)))),
    )
    requestAnimationFrame(() => {
      elements.feed.querySelectorAll('.post-body').forEach((body) => setupCollapsibleBody(body))
    })
    return
  }

  const empty = element('div', 'panel-placeholder')
  if (query) {
    empty.append(
      element('strong', '', '没有匹配的讨论。'),
      element(
        'p',
        '',
        hasMorePosts
          ? '搜索只看已经加载的帖子。换个说法，或者先加载更多。'
          : '换个说法，或者清空搜索框看全部。',
      ),
    )
  } else {
    empty.append(
      element('strong', '', '这里还很安静。'),
      element('p', '', '发出第一个问题，给社区一个开场。'),
    )
  }
  elements.feed.append(empty)
}

async function loadPosts({ preserveOpenPost = null, quiet = false } = {}) {
  if (loadingPosts) return
  loadingPosts = true
  const previouslyOpen = openPostIds()
  if (preserveOpenPost) previouslyOpen.add(String(preserveOpenPost))

  if (!quiet) {
    elements.feedStatus.hidden = false
    elements.feedStatus.textContent = '正在加载讨论…'
    elements.feedStatus.classList.remove('error')
    elements.refreshButton.classList.add('spinning')
    elements.refreshButton.disabled = true
  }

  try {
    let page = await backend.listPosts()
    const requestedPost = targetPostId()
    cachedPosts = page

    // 深链接可能指向首页之后的帖子。只有带 post 参数时才继续翻页，
    // 普通进入仍然只取一页，避免把整个讨论区都拉下来。
    while (
      requestedPost &&
      page.length === LIMITS.pageSize &&
      !cachedPosts.some((post) => String(post.id) === requestedPost)
    ) {
      page = await backend.listPosts({ before: cachedPosts.at(-1).created_at })
      cachedPosts = [...cachedPosts, ...page]
    }

    // 取满一页就假定后面还有；多问一次的代价比漏掉内容小
    hasMorePosts = page.length === LIMITS.pageSize
    renderFeed(previouslyOpen)
    elements.feedStatus.hidden = true

    if (requestedPost) {
      const target = document.getElementById(`post-${requestedPost}`)
      if (target) {
        setTargetPostUrl(requestedPost)
        clearStoredTargetPost()
      } else {
        clearStoredTargetPost()
        showToast('这条讨论不存在，或你暂时没有查看权限。', 'error')
      }
    }
  } catch (error) {
    elements.feedStatus.hidden = false
    elements.feedStatus.textContent = friendlyError(error)
    elements.feedStatus.classList.add('error')
  } finally {
    loadingPosts = false
    elements.refreshButton.classList.remove('spinning')
    elements.refreshButton.disabled = false
  }
}

async function loadMorePosts() {
  if (loadingPosts || !cachedPosts.length) return
  loadingPosts = true
  setButtonBusy(elements.loadMoreButton, true, '加载中…')

  try {
    const page = await backend.listPosts({ before: cachedPosts.at(-1).created_at })
    cachedPosts = [...cachedPosts, ...page]
    hasMorePosts = page.length === LIMITS.pageSize
    renderFeed(openPostIds())
  } catch (error) {
    showToast(friendlyError(error), 'error')
  } finally {
    loadingPosts = false
    setButtonBusy(elements.loadMoreButton, false)
  }
}

async function renderSession(nextSession) {
  session = nextSession
  if (!session) {
    ownProfile = null
    cohorts = []
    profileError = ''
    elements.accountName.textContent = ''
    elements.feed.replaceChildren()
    elements.feedbackDialog.close()
    document.querySelector('#profile-dialog').close()
    cachedPosts = []
    hasMorePosts = false
    replyDrafts.clear()
    editDrafts.clear()
    postEditDrafts.clear()
    searchQuery = ''
    elements.searchInput.value = ''
    closeNotifications()
    showPanel('feed')
    setView('login')
    return
  }

  const access = await backend.memberAccess()
  isAdmin = access.is_admin
  document.querySelector('#admin-tools').hidden = !isAdmin
  if (!access.is_member) {
    elements.inviteError.hidden = !access.is_disabled
    elements.inviteError.textContent = access.is_disabled ? '此账号已被停用。如有疑问，请联系管理员。' : ''
    elements.inviteForm.hidden = access.is_disabled
    document.querySelector('#invite-title').textContent = access.is_disabled ? '账号已停用。' : '输入邀请码，加入讨论。'
    elements.inviteCodeInput.value = ''
    setView('invite')
    return
  }

  initializeUnreadTracking()

  elements.accountName.textContent = displayName(session.user)
  try {
    ;[ownProfile, cohorts] = await Promise.all([backend.getOwnProfile(), backend.listCohorts()])
    profileError = ''
  } catch (error) {
    ownProfile = null
    cohorts = []
    profileError = friendlyError(error)
  }
  renderProfilePanel()
  updatePostIdentity()
  setView('app')
  await loadPosts()
}

async function copyCurrentEntryLink() {
  const requestedPost = targetPostId()
  const requested = cachedPosts.find((post) => String(post.id) === requestedPost)
  const url = postUrl(window.location.href, requestedPost)
  if (requestedPost) rememberTargetPost(requestedPost)
  try {
    await navigator.clipboard.writeText(postShareText(requested?.title, url))
    showToast(requestedPost ? '帖子链接已复制，请在 Safari 或 Chrome 中打开。' : '网站链接已复制，请在 Safari 或 Chrome 中打开。')
  } catch {
    showToast('请从浏览器地址栏复制完整链接，在 Safari 或 Chrome 中打开。', 'error')
  }
}

elements.copyLoginLink.addEventListener('click', copyCurrentEntryLink)
elements.copyBrowserLink.addEventListener('click', copyCurrentEntryLink)

elements.notificationButton.addEventListener('click', () => {
  const open = elements.notificationPanel.hidden
  elements.notificationPanel.hidden = !open
  elements.notificationButton.setAttribute('aria-expanded', String(open))
})

document.addEventListener('click', (event) => {
  if (!event.target.closest('.notification-menu')) closeNotifications()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeNotifications()
})

elements.loginButton.addEventListener('click', async () => {
  setButtonBusy(elements.loginButton, true, '正在登录…')
  try {
    await backend.signIn()
  } catch (error) {
    showToast(friendlyError(error), 'error')
  } finally {
    setButtonBusy(elements.loginButton, false)
  }
})

elements.logoutButton.addEventListener('click', async () => {
  setButtonBusy(elements.logoutButton, true, '退出中…')
  try {
    await backend.signOut()
  } catch (error) {
    showToast(friendlyError(error), 'error')
  } finally {
    setButtonBusy(elements.logoutButton, false)
  }
})

elements.inviteSignoutButton.addEventListener('click', async () => {
  setButtonBusy(elements.inviteSignoutButton, true, '退出中…')
  try {
    await backend.signOut()
  } catch (error) {
    showToast(friendlyError(error), 'error')
  } finally {
    setButtonBusy(elements.inviteSignoutButton, false)
  }
})

elements.inviteForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const result = validateInviteCode(elements.inviteCodeInput.value)
  if (!result.ok) {
    elements.inviteError.textContent = result.message
    elements.inviteError.hidden = false
    return
  }

  const button = elements.inviteForm.querySelector('button[type="submit"]')
  setButtonBusy(button, true, '加入中…')
  try {
    const admitted = await backend.redeemInviteCode(result.value)
    if (!admitted) {
      elements.inviteError.textContent = '邀请码无效或已用完。'
      elements.inviteError.hidden = false
      return
    }

    elements.inviteError.hidden = true
    await renderSession(session)
  } catch (error) {
    elements.inviteError.textContent = friendlyError(error)
    elements.inviteError.hidden = false
  } finally {
    setButtonBusy(button, false)
  }
})

elements.refreshButton.addEventListener('click', () => loadPosts())

elements.loadMoreButton.addEventListener('click', () => loadMorePosts())

elements.confirmCancel.addEventListener('click', () => elements.confirmDialog.close('cancel'))
elements.confirmAccept.addEventListener('click', () => elements.confirmDialog.close('confirm'))

elements.themeToggles.forEach((button) => button.addEventListener('click', toggleTheme))

elements.panelLinks.forEach((link) => {
  link.addEventListener('click', () => {
    if (link.dataset.panel === 'feed' && targetPostId()) {
      setTargetPostUrl(null)
      renderFeed(openPostIds())
    }
    showPanel(link.dataset.panel)
  })
})

elements.searchInput.addEventListener('input', () => {
  searchQuery = elements.searchInput.value
  if (targetPostId()) setTargetPostUrl(null)
  // 只有讨论广场里有可搜的东西，所以搜索时把人带回那一栏
  showPanel('feed')
  // 每次都要重建整个列表，所以别一个字符跑一次
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => renderFeed(openPostIds()), 160)
})

elements.feedbackButton.addEventListener('click', () => {
  elements.feedbackDialog.showModal()
})

elements.feedbackCancel.addEventListener('click', () => {
  elements.feedbackDialog.close()
})

elements.feedbackForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const result = validateFeedback(elements.feedbackBody.value)
  if (!result.ok) {
    showToast(result.message, 'error')
    elements.feedbackBody.focus()
    return
  }

  const button = elements.feedbackForm.querySelector('button[type="submit"]')
  setButtonBusy(button, true, '发送中…')
  try {
    await backend.createFeedback(result.value)
    elements.feedbackForm.reset()
    elements.feedbackDialog.close()
    showToast('收到了，谢谢。')
  } catch (error) {
    showToast(friendlyError(error), 'error')
  } finally {
    setButtonBusy(button, false)
  }
})

const renderPostCount = attachCharacterCount(
  elements.postBody,
  elements.postCharacterCount,
  LIMITS.postMax,
)

function composerHasDraft() {
  return Boolean(elements.postTitle.value.trim() || elements.postBody.value.trim())
}

function composerDraftLabel() {
  const title = elements.postTitle.value.trim()
  if (title) return title
  return excerptPlain(elements.postBody.value, 24)
}

function updateComposerToggle() {
  const draft = composerHasDraft()
  const anonymous = elements.postAnonymous.checked
  elements.composerToggleLabel.textContent = draft ? composerDraftLabel() : '最近遇到什么事了？'
  elements.composerHint.textContent = draft ? '继续编辑' : anonymous ? '匿名发布' : '实名发布'
  elements.composerToggle.classList.toggle('has-draft', draft)
  elements.composerToggle.setAttribute(
    'aria-label',
    draft ? `继续编辑：${composerDraftLabel()}` : `写一个${anonymous ? '匿名' : '实名'}问题`,
  )
}

function updatePostIdentity() {
  elements.postIdentity.textContent = postIdentityText(elements.postAnonymous.checked)
  updateComposerToggle()
}

function setComposerOpen(open, { focus = true } = {}) {
  elements.postForm.classList.toggle('is-open', open)
  elements.composerToggle.hidden = open
  elements.composerToggle.setAttribute('aria-expanded', String(open))
  elements.composerFields.hidden = !open
  if (open) {
    if (focus) elements.postTitle.focus()
    return
  }
  updateComposerToggle()
  if (focus) elements.composerToggle.focus()
}

elements.composerToggle.addEventListener('click', () => setComposerOpen(true))
elements.postTitle.addEventListener('input', updateComposerToggle)
elements.postBody.addEventListener('input', updateComposerToggle)
elements.postAnonymous.addEventListener('change', updatePostIdentity)

elements.postForm.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (elements.composerFields.hidden) return
  event.preventDefault()
  setComposerOpen(false)
})

elements.postForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const result = validatePost(elements.postTitle.value, elements.postBody.value)
  if (!result.ok) {
    showToast(result.message, 'error')
    if (elements.composerFields.hidden) setComposerOpen(true)
    return
  }

  const button = elements.postForm.querySelector('button[type="submit"]')
  setButtonBusy(button, true, '发布中…')
  try {
    const post = { ...result.value, is_anonymous: elements.postAnonymous.checked }
    await backend.createPost(post)
    elements.postForm.reset()
    renderPostCount()
    updatePostIdentity()
    setComposerOpen(false, { focus: false })
    await loadPosts()
    showToast(post.is_anonymous ? '已匿名发布。' : '问题已发布。')
  } catch (error) {
    showToast(friendlyError(error), 'error')
  } finally {
    setButtonBusy(button, false)
  }
})

updatePostIdentity()

async function start() {
  applyLimits()
  restoreTargetPostUrl()
  elements.wechatBrowserNotice.hidden = !isWechatBrowser()
  elements.demoBanner.hidden = !backend.isDemo
  if (backend.isDemo) elements.loginButton.querySelector('span').textContent = '进入演示版'

  backend.onAuthChange((nextSession) => {
    renderSession(nextSession).catch((error) => {
      setView('login')
      showToast(friendlyError(error), 'error')
    })
  })

  try {
    await renderSession(await backend.getSession())
  } catch (error) {
    setView('login')
    showToast(friendlyError(error), 'error')
  }
}

start()

async function loadAdminMembers() {
  const list = document.querySelector('#admin-members')
  list.textContent = '加载中…'
  try {
    const members = await backend.adminMembers()
    list.replaceChildren()
    for (const member of members) {
      const row = element('div', 'admin-member')
      const identity = element('div')
      const roleText = roleLabel(member.role, member.cohort_name) || '未选角色'
      identity.append(
        element('strong', '', member.display_name || member.name || '成员'),
        element('p', '', member.email || ''),
        element('p', '', member.role_verified ? `${roleText} · 已认证` : roleText),
      )
      row.append(identity, element('span', '', member.is_admin ? '管理员' : member.is_disabled ? '已停用' : '正常'))
      if (member.role) {
        const verify = element('button', 'text-button', member.role_verified ? '取消认证' : '认证角色')
        verify.type = 'button'
        verify.addEventListener('click', async () => {
          setButtonBusy(verify, true, '保存中…')
          try {
            await backend.adminSetRoleVerified(member.user_id, !member.role_verified)
            await loadAdminMembers()
            showToast(member.role_verified ? '已取消认证。' : '已认证这个角色。')
          } catch (error) {
            showToast(friendlyError(error), 'error')
            setButtonBusy(verify, false)
          }
        })
        row.append(verify)
      }
      if (!member.is_admin) {
        const button = element('button', 'text-button', member.is_disabled ? '恢复账号' : '停用账号')
        button.type = 'button'
        button.addEventListener('click', async () => {
          if (!await confirmAction({ title: member.is_disabled ? '恢复这个账号？' : '停用这个账号？', body: `${member.name || '成员'}（${member.email || ''}）${member.is_disabled ? '将重新获得社区访问权限。' : '将无法访问社区、发帖、回复或点赞。已有内容会保留。'}`, confirmLabel: member.is_disabled ? '恢复' : '停用' })) return
          setButtonBusy(button, true, '保存中…')
          try {
            await backend.adminSetDisabled(member.user_id, !member.is_disabled)
            await loadAdminMembers()
            showToast('账号状态已更新。')
          } catch (error) { showToast(friendlyError(error), 'error'); setButtonBusy(button, false) }
        })
        row.append(button)
      }
      list.append(row)
    }
  } catch (error) { list.textContent = friendlyError(error) }
}
document.querySelector('#admin-load-members').addEventListener('click', loadAdminMembers)

function linkableProfile(item, anonymous) {
  if (anonymous || !item?.author_public_id) return null
  return () => showProfile(item.author_public_id)
}

function makeAuthorName(name, publicId, anonymous, className) {
  const label = anonymous ? '匿名成员' : name || '成员'
  if (anonymous || !publicId) return element('strong', className, label)
  const button = element('button', `author-link ${className}`)
  button.type = 'button'
  button.textContent = label
  button.addEventListener('click', () => showProfile(publicId))
  return button
}

function makeRoleTag(role, cohortName, verified) {
  const label = roleLabel(role, cohortName)
  if (!label) return null
  const tag = element('span', 'role-tag', label)
  if (verified) tag.append(element('span', 'verified-mark', '✓ 已认证'))
  return tag
}

function fieldLabel(text, control) {
  const label = element('label', '', text)
  label.htmlFor = control.id
  return label
}

function textInput(id, value, max) {
  const input = document.createElement('input')
  input.id = id
  input.type = 'text'
  input.maxLength = max
  input.value = value || ''
  input.autocomplete = 'off'
  return input
}

function selectInput(id, options, value) {
  const select = document.createElement('select')
  select.id = id
  for (const [optionValue, label] of options) select.append(new Option(label, optionValue))
  select.value = value == null ? '' : String(value)
  return select
}

function publicToggle(field, checked) {
  const label = element('label', 'checkbox-line')
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.id = `${field.id}-public`
  input.checked = Boolean(checked)
  label.append(input, element('span', '', '对成员公开'))
  const sync = () => {
    input.disabled = !field.value.trim()
    if (input.disabled) input.checked = false
  }
  field.addEventListener('input', sync)
  sync()
  return { label, input }
}

function profileAvatarBlock(profile) {
  const block = element('div', 'profile-avatar-block')
  const host = element('div')
  host.id = 'profile-avatar-host'
  host.append(makeAvatar(profile.display_name, profile.avatar_url))
  const file = document.createElement('input')
  file.type = 'file'
  file.accept = 'image/jpeg,image/png,image/webp'
  file.hidden = true
  file.addEventListener('change', () => {
    const chosen = file.files?.[0]
    file.value = ''
    if (chosen) changeAvatar(chosen)
  })
  const pick = element('button', 'text-button', '更换头像')
  pick.type = 'button'
  pick.addEventListener('click', () => file.click())
  const clear = element('button', 'text-button', '改回默认头像')
  clear.id = 'clear-avatar-button'
  clear.type = 'button'
  clear.hidden = !isUploadedAvatar(profile.avatar_url)
  clear.addEventListener('click', resetAvatar)
  block.append(host, pick, clear, file)
  return block
}

function appendContact(list, label, ...nodes) {
  const dd = element('dd')
  dd.append(...nodes)
  list.append(element('dt', '', label), dd)
}

function appendPublicContacts(list, profile) {
  if (profile.linkedin_url && validLinkedInUrl(profile.linkedin_url)) {
    const link = element('a', '', '打开 LinkedIn')
    link.href = profile.linkedin_url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    appendContact(list, 'LinkedIn', link)
  }
  if (profile.contact_email && validContactEmail(profile.contact_email)) {
    const link = element('a', '', profile.contact_email)
    link.href = `mailto:${profile.contact_email}`
    appendContact(list, '邮箱', link)
  }
  if (profile.wechat_id) {
    const copy = element('button', 'text-button', '复制微信号')
    copy.type = 'button'
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(profile.wechat_id)
        showToast('微信号已复制。')
      } catch {
        showToast(`复制失败，微信号是 ${profile.wechat_id}`)
      }
    })
    appendContact(list, '微信', element('span', '', profile.wechat_id), copy)
  }
}

function buildProfileSummary(profile) {
  const card = element('div')
  const head = element('div', 'profile-head')
  const identity = element('div')
  identity.append(element('h2', 'profile-name', profile.display_name || '成员'))
  if (profile.tagline) identity.append(element('p', 'profile-tagline', profile.tagline))
  const tag = makeRoleTag(profile.role, profile.cohort_name, profile.role_verified)
  if (tag) identity.append(tag)
  const yearText = graduationLabel(profile.graduation_year)
  if (yearText) identity.append(element('p', 'profile-note', yearText))
  head.append(makeAvatar(profile.display_name, profile.avatar_url), identity)
  card.append(head)

  if (profile.bio) card.append(makeMarkdownBody('profile-bio', profile.bio))

  const contacts = element('dl', 'profile-contacts')
  appendPublicContacts(contacts, profile)
  card.append(contacts.childElementCount ? contacts : element('p', 'profile-empty', '没有公开联系方式。'))
  return card
}

function buildProfileForm() {
  const profile = ownProfile
  const form = element('form', 'profile-form')

  const name = textInput('profile-name-input', profile.display_name, LIMITS.displayNameMax)
  name.required = true
  const tagline = textInput('profile-tagline-input', profile.tagline, LIMITS.taglineMax)
  const bio = document.createElement('textarea')
  bio.id = 'profile-bio-input'
  bio.rows = 5
  bio.maxLength = LIMITS.bioMax
  bio.value = profile.bio || ''
  const bioCount = element('span', 'character-count')
  attachCharacterCount(bio, bioCount, LIMITS.bioMax)

  const role = selectInput('profile-role-input', [['', '未选择'], ...Object.entries(ROLES)], profile.role)

  const cohortOptions = cohorts.map((item) => [String(item.id), item.name])
  if (profile.cohort_id && !cohortOptions.some(([id]) => id === String(profile.cohort_id))) {
    cohortOptions.push([String(profile.cohort_id), profile.cohort_name || '当前班级'])
  }
  const cohort = selectInput(
    'profile-cohort-input',
    [['', cohorts.length ? '尚未选择' : '班级还没建好'], ...cohortOptions],
    profile.cohort_id,
  )
  const years = []
  for (let value = GRADUATION_YEAR_MAX; value >= GRADUATION_YEAR_MIN; value -= 1) years.push([String(value), String(value)])
  const year = selectInput('profile-year-input', [['', '未选择'], ...years], profile.graduation_year)

  const studentFields = element('div')
  studentFields.append(fieldLabel('班级', cohort), cohort)
  if (!cohorts.length) {
    studentFields.append(element('p', 'profile-note', '班级还没建好，可以先保存角色，之后再选。'))
  }
  studentFields.append(fieldLabel('毕业年份', year), year)

  const roleHint = element('p', 'profile-note', '改了角色或班级后，认证会取消。')
  const syncRole = () => {
    const student = role.value === 'student'
    studentFields.hidden = !student
    const changed = role.value !== (profile.role || '')
      || (student && cohort.value !== String(profile.cohort_id || ''))
    roleHint.hidden = !(profile.role_verified && changed)
  }
  role.addEventListener('change', syncRole)
  cohort.addEventListener('change', syncRole)
  syncRole()

  const linkedin = textInput('profile-linkedin-input', profile.linkedin_url, 160)
  linkedin.placeholder = 'https://www.linkedin.com/in/…'
  linkedin.inputMode = 'url'
  const linkedinPublic = publicToggle(linkedin, profile.linkedin_public)

  const email = textInput('profile-email-input', profile.contact_email, 120)
  email.placeholder = 'name@example.com'
  email.inputMode = 'email'
  const emailPublic = publicToggle(email, profile.email_public)

  const wechat = textInput('profile-wechat-input', profile.wechat_id, 20)
  wechat.placeholder = '字母开头，6 到 20 位'
  const wechatPublic = publicToggle(wechat, profile.wechat_public)

  const actions = element('div', 'composer-actions')
  const save = element('button', 'primary-button', '保存')
  save.type = 'submit'
  actions.append(save)

  form.append(
    profileAvatarBlock(profile),
    fieldLabel('昵称', name), name,
    fieldLabel('一句话介绍', tagline), tagline,
    fieldLabel('自我介绍', bio), bio, bioCount,
    fieldLabel('角色', role), role, roleHint,
    studentFields,
    fieldLabel('LinkedIn', linkedin), linkedin, linkedinPublic.label,
    fieldLabel('公开邮箱', email), email,
    element('p', 'profile-note', '这是你想公开的联系邮箱，不会自动填成登录用的 Gmail。'),
    emailPublic.label,
    fieldLabel('微信号', wechat), wechat, wechatPublic.label,
    actions,
  )

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const result = validateProfile({
      display_name: name.value,
      tagline: tagline.value,
      bio: bio.value,
      linkedin_url: linkedin.value,
      linkedin_public: linkedinPublic.input.checked,
      contact_email: email.value,
      email_public: emailPublic.input.checked,
      wechat_id: wechat.value,
      wechat_public: wechatPublic.input.checked,
      role: role.value,
      cohort_id: cohort.value,
      graduation_year: year.value,
    })
    if (!result.ok) {
      showToast(result.message, 'error')
      return
    }
    setButtonBusy(save, true, '保存中…')
    try {
      const saved = await backend.updateOwnProfile(result.value)
      await profileChanged(saved, '资料已保存。实名内容上的名字会一起更新。')
      renderProfilePanel()
    } catch (error) {
      showToast(friendlyError(error), 'error')
      setButtonBusy(save, false)
    }
  })
  return form
}

function renderProfilePanel() {
  const root = document.querySelector('#profile-panel')
  root.replaceChildren()
  if (profileError) {
    const error = element('div', 'panel-placeholder')
    error.append(element('strong', '', '个人资料暂时加载不了。'), element('p', '', profileError))
    root.append(error)
  } else if (ownProfile) {
    root.append(buildProfileForm())
  }
}

async function cropAvatarFile(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('头像只支持 JPG、PNG 或 WebP。')
  }
  if (file.size > 8 * 1024 * 1024) throw new Error('原图不能超过 8MB。')

  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  canvas.getContext('2d').drawImage(
    bitmap,
    Math.floor((bitmap.width - side) / 2),
    Math.floor((bitmap.height - side) / 2),
    side,
    side,
    0,
    0,
    256,
    256,
  )
  bitmap.close?.()
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86))
  if (!blob) throw new Error('这个浏览器没法把图片转成 WebP。')
  if (blob.size > 1024 * 1024) throw new Error('裁剪后的头像仍然太大，请换一张。')
  return blob
}

async function profileChanged(profile, message) {
  ownProfile = profile
  updatePostIdentity()
  await loadPosts({ quiet: true })
  showToast(message)
}

// Patch the avatar in place so unsaved text in the form survives the upload.
async function avatarChanged(profile, message) {
  document.querySelector('#profile-avatar-host')
    ?.replaceChildren(makeAvatar(profile.display_name, profile.avatar_url))
  const clear = document.querySelector('#clear-avatar-button')
  if (clear) clear.hidden = !isUploadedAvatar(profile.avatar_url)
  await profileChanged(profile, message)
}

async function changeAvatar(file) {
  try {
    const blob = await cropAvatarFile(file)
    await avatarChanged(await backend.uploadAvatar(blob), '头像已更新。实名内容会一起换上。')
  } catch (error) {
    showToast(friendlyError(error), 'error')
  }
}

async function resetAvatar() {
  try {
    await avatarChanged(await backend.clearAvatar(), '已改回默认头像。')
  } catch (error) {
    showToast(friendlyError(error), 'error')
  }
}

async function showProfile(publicId) {
  const dialog = document.querySelector('#profile-dialog')
  const card = document.querySelector('#profile-card')
  card.replaceChildren(element('p', 'profile-empty', '正在加载…'))
  if (!dialog.open) dialog.showModal()
  try {
    const profile = await backend.getProfile(publicId)
    if (!profile) {
      card.replaceChildren(element('p', 'profile-empty', '这个主页不存在，或对方已停用。'))
      return
    }
    const summary = buildProfileSummary(profile)
    if (profile.is_self) {
      const edit = element('button', 'secondary-button profile-edit', '编辑资料')
      edit.type = 'button'
      edit.addEventListener('click', () => {
        dialog.close()
        showPanel('me')
      })
      summary.append(edit)
    }
    card.replaceChildren(summary)
  } catch (error) {
    card.replaceChildren(element('p', 'profile-empty', friendlyError(error)))
  }
}

document.querySelector('#profile-dialog-close').addEventListener('click', () => {
  document.querySelector('#profile-dialog').close()
})

