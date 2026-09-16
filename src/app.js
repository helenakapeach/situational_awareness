import './styles.css'
import { createBackend } from './backend.js'
import {
  LIMITS,
  displayName,
  formatRelativeTime,
  initials,
  safeAvatarUrl,
  validateInviteCode,
  validatePost,
  validateReply,
} from './lib.js'

const backend = createBackend()
const elements = {
  accountName: document.querySelector('#account-name'),
  app: document.querySelector('#app-view'),
  demoBanner: document.querySelector('#demo-banner'),
  feed: document.querySelector('#feed'),
  feedStatus: document.querySelector('#feed-status'),
  inviteCodeInput: document.querySelector('#invite-code-input'),
  inviteError: document.querySelector('#invite-error'),
  inviteForm: document.querySelector('#invite-form'),
  inviteSignoutButton: document.querySelector('#invite-signout-button'),
  inviteView: document.querySelector('#invite-view'),
  loading: document.querySelector('#loading-view'),
  login: document.querySelector('#signed-out-view'),
  loginButton: document.querySelector('#login-button'),
  logoutButton: document.querySelector('#logout-button'),
  postBody: document.querySelector('#post-body'),
  postCharacterCount: document.querySelector('#post-character-count'),
  postForm: document.querySelector('#post-form'),
  postTitle: document.querySelector('#post-title'),
  refreshButton: document.querySelector('#refresh-button'),
  toast: document.querySelector('#toast'),
}

let session = null
let loadingPosts = false
let toastTimer = null

function setView(view) {
  elements.loading.hidden = view !== 'loading'
  elements.login.hidden = view !== 'login'
  elements.inviteView.hidden = view !== 'invite'
  elements.app.hidden = view !== 'app'
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

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
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

function makeReply(reply) {
  const item = element('li', 'reply')
  item.append(makeAvatar(reply.author_name, reply.author_avatar_url))

  const content = element('div', 'reply-content')
  const header = element('div', 'reply-header')
  header.append(
    element('strong', 'reply-name', reply.author_name || 'Google 用户'),
    element('time', 'reply-time', formatRelativeTime(reply.created_at)),
  )
  const body = element('p', 'reply-body', reply.body)
  content.append(header, body)
  item.append(content)
  return item
}

function makeReplyForm(postId) {
  const form = element('form', 'reply-form')
  const label = element('label', 'sr-only', '写下你的回复')
  const textarea = document.createElement('textarea')
  const actions = element('div', 'reply-actions')
  const identity = element('span', 'reply-identity', `将以 ${displayName(session?.user)} 的名义回复`)
  const button = element('button', 'secondary-button', '发布回复')

  label.htmlFor = `reply-${postId}`
  textarea.id = `reply-${postId}`
  textarea.name = 'reply'
  textarea.rows = 3
  textarea.maxLength = LIMITS.replyMax
  textarea.placeholder = '分享你的判断、经历或一个值得追问的问题…'
  textarea.required = true
  button.type = 'submit'

  actions.append(identity, button)
  form.append(label, textarea, actions)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const result = validateReply(textarea.value)
    if (!result.ok) {
      showToast(result.message, 'error')
      textarea.focus()
      return
    }

    setButtonBusy(button, true, '发布中…')
    try {
      await backend.createReply(postId, result.value)
      textarea.value = ''
      await loadPosts({ preserveOpenPost: String(postId) })
      showToast('回复已发布。')
    } catch (error) {
      showToast(friendlyError(error), 'error')
    } finally {
      setButtonBusy(button, false)
    }
  })

  return form
}

function makePost(post, shouldOpen = false) {
  const article = element('article', 'post-card')

  const header = element('header', 'post-header')
  header.append(makeAvatar('', '', true))
  const meta = element('div', 'post-meta')
  meta.append(
    element('strong', 'post-author', '匿名成员'),
    element('time', 'post-time', formatRelativeTime(post.created_at)),
  )
  header.append(meta)

  const title = element('h3', 'post-title', post.title)
  const body = element('p', 'post-body', post.body)

  const thread = document.createElement('details')
  thread.className = 'thread'
  thread.dataset.postId = String(post.id)
  thread.open = shouldOpen

  const summary = document.createElement('summary')
  summary.textContent = post.replies.length ? `${post.replies.length} 条回复` : '还没有回复'
  thread.append(summary)

  const replies = element('ol', 'reply-list')
  if (post.replies.length) {
    post.replies.forEach((reply) => replies.append(makeReply(reply)))
  } else {
    replies.append(element('li', 'empty-replies', '成为第一个给出视角的人。'))
  }

  thread.append(replies, makeReplyForm(post.id))
  article.append(header, title, body, thread)
  return article
}

function openPostIds() {
  return new Set(
    [...elements.feed.querySelectorAll('details[open][data-post-id]')].map(
      (details) => details.dataset.postId,
    ),
  )
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
    const posts = await backend.listPosts()
    elements.feed.replaceChildren()

    if (!posts.length) {
      const empty = element('div', 'empty-feed')
      empty.append(
        element('strong', '', '这里还很安静。'),
        element('p', '', '发出第一个问题，给社区一个开场。'),
      )
      elements.feed.append(empty)
    } else {
      posts.forEach((post) => elements.feed.append(makePost(post, previouslyOpen.has(String(post.id)))))
    }

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

async function renderSession(nextSession) {
  session = nextSession
  if (!session) {
    elements.accountName.textContent = ''
    elements.feed.replaceChildren()
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

elements.postBody.addEventListener('input', () => {
  elements.postCharacterCount.textContent = `${elements.postBody.value.length} / ${LIMITS.postMax}`
})

elements.postForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const result = validatePost(elements.postTitle.value, elements.postBody.value)
  if (!result.ok) {
    showToast(result.message, 'error')
    return
  }

  const button = elements.postForm.querySelector('button[type="submit"]')
  setButtonBusy(button, true, '发布中…')
  try {
    await backend.createPost(result.value)
    elements.postForm.reset()
    elements.postCharacterCount.textContent = `0 / ${LIMITS.postMax}`
    await loadPosts()
    showToast('已匿名发布。')
  } catch (error) {
    showToast(friendlyError(error), 'error')
  } finally {
    setButtonBusy(button, false)
  }
})

async function start() {
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
