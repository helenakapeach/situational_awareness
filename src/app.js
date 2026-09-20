import './styles.css'
import { createBackend } from './backend.js'
import {
  LIMITS,
  displayName,
  excerptPlain,
  formatRelativeTime,
  initials,
  safeAvatarUrl,
  validateFeedback,
  validateInviteCode,
  validatePost,
  validateReply,
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
  loading: document.querySelector('#loading-view'),
  login: document.querySelector('#signed-out-view'),
  loginButton: document.querySelector('#login-button'),
  logoutButton: document.querySelector('#logout-button'),
  panelLinks: document.querySelectorAll('.panel-link'),
  panels: document.querySelectorAll('.panel'),
  composerFields: document.querySelector('#composer-fields'),
  composerHint: document.querySelector('#composer-hint'),
  composerToggle: document.querySelector('#composer-toggle'),
  composerToggleLabel: document.querySelector('#composer-toggle-label'),
  postBody: document.querySelector('#post-body'),
  postCharacterCount: document.querySelector('#post-character-count'),
  postForm: document.querySelector('#post-form'),
  postTitle: document.querySelector('#post-title'),
  refreshButton: document.querySelector('#refresh-button'),
  searchInput: document.querySelector('#search-input'),
  themeToggles: document.querySelectorAll('.theme-toggle'),
  toast: document.querySelector('#toast'),
}

const THEME_KEY = 'situational-awareness-theme'

let session = null
let loadingPosts = false
let toastTimer = null
let searchTimer = null
// 搜索只筛已经取回的这批帖子，不再打一次后端
let cachedPosts = []
let hasMorePosts = false
let searchQuery = ''

// 回复框和编辑框都是 renderFeed 现搭的，任何一次重绘都会把它们连同里面
// 没提交的字一起扔掉。草稿存在 DOM 之外，重绘后再填回去。
const replyDrafts = new Map()
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

function makeAvatar(name, avatarUrl, anonymous = false) {
  const wrapper = element('div', anonymous ? 'avatar anonymous' : 'avatar')
  wrapper.setAttribute('aria-hidden', 'true')

  if (anonymous) {
    wrapper.textContent = '?'
    return wrapper
  }

  const safeUrl = safeAvatarUrl(avatarUrl)
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

function makeReply(reply, { highlighted = false } = {}) {
  const draftKey = String(reply.id)
  const anonymous = Boolean(reply.is_anonymous)
  const item = element('li', highlighted ? 'reply is-insight' : 'reply')
  item.append(makeAvatar(reply.author_name, reply.author_avatar_url, anonymous))

  const content = element('div', 'reply-content')
  const header = element('div', 'reply-header')
  header.append(
    element('strong', 'reply-name', anonymous ? '匿名成员' : reply.author_name || 'Google 用户'),
    element('time', 'reply-time', formatRelativeTime(reply.created_at)),
  )
  if (reply.updated_at) {
    header.append(element('span', 'reply-edited', '已编辑'))
  }

  const body = makeMarkdownBody('reply-body', reply.body)
  const toolbar = makeReplyToolbar(reply, {
    onEdit: () => enterEdit(),
  })

  content.append(header, body, toolbar)
  item.append(content)

  function showView() {
    editDrafts.delete(draftKey)
    body.hidden = false
    toolbar.hidden = false
    content.querySelector('.reply-form')?.remove()
  }

  function enterEdit({ focus = true } = {}) {
    if (content.querySelector('.reply-form')) return

    body.hidden = true
    toolbar.hidden = true

    const form = element('form', 'reply-form')
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

function makeReplyToolbar(reply, { onEdit }) {
  const toolbar = element('div', 'reply-toolbar')
  toolbar.append(makeReplyVoteButton(reply))

  if (!reply.is_mine) return toolbar

  const own = element('div', 'reply-own-actions')
  const edit = element('button', 'text-button', '编辑')
  const remove = element('button', 'text-button danger', '删除')
  edit.type = 'button'
  remove.type = 'button'
  edit.addEventListener('click', onEdit)
  remove.addEventListener('click', async () => {
    const confirmed = await confirmAction({
      title: '删除这条回复？',
      body: '赞也会一起去掉，删掉之后没法恢复。',
      confirmLabel: '删除',
    })
    if (!confirmed) return

    setButtonBusy(remove, true, '删除中…')
    try {
      await backend.deleteReply(reply.id)
      editDrafts.delete(String(reply.id))
      await loadPosts({ preserveOpenPost: String(reply.post_id) })
      showToast('回复已删除。')
    } catch (error) {
      showToast(friendlyError(error), 'error')
      setButtonBusy(remove, false)
    }
  })
  own.append(edit, remove)
  toolbar.append(own)
  return toolbar
}

function replyIdentityText(anonymous) {
  return anonymous
    ? '将以匿名身份回复'
    : `将以 ${displayName(session?.user)} 的名义回复`
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

function makeReplyForm(postId) {
  const draftKey = String(postId)
  const draft = replyDrafts.get(draftKey)
  const form = element('form', 'reply-form')
  const label = element('label', 'sr-only', '写下你的回复')
  const textarea = document.createElement('textarea')
  const actions = element('div', 'reply-actions')
  const meta = element('div', 'reply-meta')
  const count = element('span', 'character-count')
  const anonymousLabel = element('label', 'checkbox-line')
  const anonymousInput = document.createElement('input')
  const identity = element('span', 'reply-identity')
  const button = element('button', 'secondary-button', '发布回复')

  label.htmlFor = `reply-${postId}`
  textarea.id = `reply-${postId}`
  textarea.name = 'reply'
  textarea.rows = 3
  textarea.maxLength = LIMITS.replyMax
  textarea.placeholder = '分享你的判断、经历或一个值得追问的问题…'
  textarea.required = true
  textarea.value = draft?.body || ''

  anonymousInput.type = 'checkbox'
  anonymousInput.name = 'anonymous'
  anonymousInput.checked = Boolean(draft?.anonymous)
  anonymousLabel.append(anonymousInput, document.createTextNode('匿名回复'))
  identity.id = `reply-identity-${postId}`
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
      await backend.createReply(postId, result.value)
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
  const who = reply.is_anonymous ? '匿名成员' : reply.author_name || 'Google 用户'
  const byline = element('span', 'insight-preview-who')
  byline.append(element('span', 'insight-preview-mark', '高赞'), who)
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
  replyDrafts.delete(String(post.id))
  for (const reply of post.replies) editDrafts.delete(String(reply.id))
}

function makePost(post, shouldOpen = false) {
  const article = element('article', 'post-card')
  const draftKey = String(post.id)

  const header = element('header', 'post-header')
  header.append(makeAvatar('', '', true))
  const meta = element('div', 'post-meta')
  meta.append(
    element('strong', 'post-author', '匿名成员'),
    element('time', 'post-time', formatRelativeTime(post.created_at)),
  )
  if (post.updated_at) {
    meta.append(element('span', 'reply-edited', '已编辑'))
  }
  header.append(meta)

  const heading = element('div', 'post-heading')
  heading.append(element('h3', 'post-title', post.title), makePostVoteButton(post))
  const body = makeMarkdownBody('post-body', post.body)

  // 有草稿却折叠起来，等于把它藏没了
  const hasDraft =
    replyDrafts.has(draftKey) || post.replies.some((reply) => editDrafts.has(String(reply.id)))

  const open = shouldOpen || hasDraft
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

  const replies = element('ol', 'reply-list')
  if (post.replies.length) {
    post.replies.forEach((reply, index) => {
      const highlighted = index === 0 && Number(reply.upvote_count) > 0
      replies.append(makeReply(reply, { highlighted }))
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
  })

  const topReply = post.replies[0]
  const insight = topReply && Number(topReply.upvote_count) > 0 ? topReply : null
  const insightEl = insight ? makeInsightPreview(insight) : null
  const engage = element('div', 'post-engage')
  engage.append(toggle)
  article.append(header, heading, body)
  if (insightEl) article.append(insightEl)
  article.append(engage, panel)

  function showView() {
    postEditDrafts.delete(draftKey)
    heading.hidden = false
    body.hidden = false
    if (insightEl) insightEl.hidden = false
    const more = bodyMoreButton(body)
    if (more) more.hidden = false
    article.querySelector('.post-edit')?.remove()
    requestAnimationFrame(() => setupCollapsibleBody(body))
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

  if (post.is_mine) {
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
        await backend.deletePost(post.id)
        forgetPostDrafts(post)
        await loadPosts()
        showToast('讨论已删除。')
      } catch (error) {
        showToast(friendlyError(error), 'error')
        setButtonBusy(remove, false)
      }
    })
    own.append(edit, remove)
    header.append(own)
  }

  if (postEditDrafts.has(draftKey)) enterEdit({ focus: false })
  requestAnimationFrame(() => setupCollapsibleBody(body))
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

async function loadPosts({ preserveOpenPost } = {}) {
  if (loadingPosts) return
  loadingPosts = true
  const previouslyOpen = openPostIds()
  if (preserveOpenPost) previouslyOpen.add(String(preserveOpenPost))

  elements.feedStatus.hidden = false
  elements.feedStatus.textContent = '正在加载讨论…'
  elements.feedStatus.classList.remove('error')
  elements.refreshButton.classList.add('spinning')
  elements.refreshButton.disabled = true

  try {
    const page = await backend.listPosts()
    cachedPosts = page
    // 取满一页就假定后面还有；多问一次的代价比漏掉内容小
    hasMorePosts = page.length === LIMITS.pageSize
    renderFeed(previouslyOpen)
    elements.feedStatus.hidden = true
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
    elements.accountName.textContent = ''
    elements.feed.replaceChildren()
    elements.feedbackDialog.close()
    cachedPosts = []
    hasMorePosts = false
    replyDrafts.clear()
    editDrafts.clear()
    postEditDrafts.clear()
    searchQuery = ''
    elements.searchInput.value = ''
    showPanel('feed')
    setView('login')
    return
  }

  const isMember = await backend.isMember(session.user.id)
  if (!isMember) {
    elements.inviteError.hidden = true
    elements.inviteCodeInput.value = ''
    setView('invite')
    return
  }

  elements.accountName.textContent = displayName(session.user)
  setView('app')
  await loadPosts()
}

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
  link.addEventListener('click', () => showPanel(link.dataset.panel))
})

elements.searchInput.addEventListener('input', () => {
  searchQuery = elements.searchInput.value
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
  elements.composerToggleLabel.textContent = draft ? composerDraftLabel() : '最近遇到什么事了？'
  elements.composerHint.textContent = draft ? '继续编辑' : '匿名发布'
  elements.composerToggle.classList.toggle('has-draft', draft)
  elements.composerToggle.setAttribute(
    'aria-label',
    draft ? `继续编辑：${composerDraftLabel()}` : '写一个匿名问题',
  )
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
    await backend.createPost(result.value)
    elements.postForm.reset()
    renderPostCount()
    setComposerOpen(false, { focus: false })
    await loadPosts()
    showToast('已匿名发布。')
  } catch (error) {
    showToast(friendlyError(error), 'error')
  } finally {
    setButtonBusy(button, false)
  }
})

updateComposerToggle()

async function start() {
  applyLimits()
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
