import { createClient } from '@supabase/supabase-js'
import { normalizeInviteCode, sortReplies, withVoteState } from './lib.js'

const DEMO_STORAGE_KEY = 'situational-awareness-demo-v2'
const DEMO_SESSION_KEY = 'situational-awareness-demo-session'
const DEMO_MEMBER_KEY = 'situational-awareness-demo-member'
const DEMO_INVITE_CODE = 'DEMO2026'

const demoUser = {
  id: 'demo-user',
  user_metadata: {
    full_name: 'MVP 测试用户',
    avatar_url: '',
  },
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
}

function initialDemoData() {
  return {
    nextPostId: 3,
    nextReplyId: 5,
    nextFeedbackId: 1,
    feedback: [],
    posts: [
      {
        id: 2,
        title: '老板让我接一个高曝光项目，但资源明显不够，该接吗？',
        body: '项目能让我接触到更高层，但时间线不现实，而且没有明确的人力支持。我担心接了做砸，不接又像是在躲机会。\n\n我目前在权衡：\n\n- **接**：曝光高，但资源缺口很大\n- **不接**：保住质量，但可能被看成回避机会\n\n你们会怎么判断？',
        created_at: hoursAgo(2),
      },
      {
        id: 1,
        title: '如何告诉同事：他的方案方向可能从一开始就错了？',
        body: '我们关系不错，但他已经在这个方案上投入很多。我有一些用户数据支持不同方向，不想让反馈听起来像是在否定他本人。',
        created_at: hoursAgo(27),
      },
    ],
    replies: [
      {
        id: 3,
        post_id: 2,
        author_name: '林然',
        author_avatar_url: '',
        is_anonymous: false,
        body: '我会先把 **接项目** 和 **接受当前资源条件** 拆开。可以接，但先写成一页请老板选择取舍：\n\n1. 成功条件是什么\n2. 缺哪些人和时间\n3. 做不到时怎么收场',
        created_at: hoursAgo(1),
        upvote_count: 1,
      },
      {
        id: 4,
        post_id: 1,
        author_name: '周宁',
        author_avatar_url: '',
        is_anonymous: false,
        body: '如果对方在意面子，可以把数据框成“我们一起还没解释清楚的现象”，让他有空间把方案改成自己的下一版，而不是被当众纠正。',
        created_at: hoursAgo(10),
        upvote_count: 3,
      },
      {
        id: 2,
        post_id: 1,
        author_name: 'Wendy Zhang',
        author_avatar_url: '',
        is_anonymous: false,
        body: '先从共同目标切入，再把数据当作一个需要一起解释的新信号，而不是结论。比如：“这组结果和我们的假设不太一样，我们一起看看可能漏掉了什么？”',
        created_at: hoursAgo(18),
        upvote_count: 0,
      },
      {
        id: 1,
        post_id: 1,
        author_name: '匿名成员',
        author_avatar_url: '',
        is_anonymous: true,
        body: '如果时间允许，可以先私下聊，不要在大会议里第一次提出。给对方保留重新包装方案的空间。',
        created_at: hoursAgo(21),
        upvote_count: 3,
      },
    ],
    reply_votes: [
      { reply_id: 1, user_id: 'seed-a' },
      { reply_id: 1, user_id: 'seed-b' },
      { reply_id: 1, user_id: 'demo-user' },
      { reply_id: 3, user_id: 'seed-c' },
      { reply_id: 4, user_id: 'seed-d' },
      { reply_id: 4, user_id: 'seed-e' },
      { reply_id: 4, user_id: 'seed-f' },
    ],
  }
}

function hasValidConfig(url, key) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && Boolean(key) && !url.includes('YOUR_PROJECT')
  } catch {
    return false
  }
}

function redirectUrl() {
  return new URL('.', window.location.href).href.split('?')[0].split('#')[0]
}

export function createBackend() {
  const url = import.meta.env.VITE_SUPABASE_URL || ''
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || ''
  const requestedDemo = new URLSearchParams(window.location.search).get('demo') === '1'

  if (requestedDemo || !hasValidConfig(url, key)) {
    return createDemoBackend()
  }

  const supabase = createClient(url, key, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
      persistSession: true,
    },
  })

  return {
    isDemo: false,

    async getSession() {
      const { data, error } = await supabase.auth.getSession()
      if (error) throw error
      return data.session
    },

    onAuthChange(callback) {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session))
      return () => data.subscription.unsubscribe()
    },

    async signIn() {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: redirectUrl() },
      })
      if (error) throw error
    },

    async signOut() {
      const { error } = await supabase.auth.signOut()
      if (error) throw error
    },

    async isMember(userId) {
      const { data, error } = await supabase
        .from('members')
        .select('user_id')
        .eq('user_id', userId)
        .maybeSingle()

      if (error) throw error
      return Boolean(data)
    },

    async redeemInviteCode(code) {
      const { data, error } = await supabase.rpc('redeem_invite_code', { p_code: code })
      if (error) throw error
      return Boolean(data)
    },

    async listPosts() {
      const { data: posts, error: postsError } = await supabase
        .from('posts')
        .select('id,title,body,created_at')
        .order('created_at', { ascending: false })
        .limit(50)

      if (postsError) throw postsError
      if (!posts.length) return []

      const { data: replies, error: repliesError } = await supabase
        .from('replies')
        .select('id,post_id,author_name,author_avatar_url,is_anonymous,body,created_at,upvote_count,reply_votes(reply_id)')
        .in('post_id', posts.map((post) => post.id))

      if (repliesError) throw repliesError

      const repliesByPost = new Map()
      for (const { reply_votes, ...reply } of replies || []) {
        const key = String(reply.post_id)
        if (!repliesByPost.has(key)) repliesByPost.set(key, [])
        repliesByPost.get(key).push(withVoteState(reply, reply_votes && reply_votes.length > 0))
      }

      return posts.map((post) => ({
        ...post,
        replies: sortReplies(repliesByPost.get(String(post.id)) || []),
      }))
    },

    async createPost(post) {
      const { error } = await supabase.from('posts').insert(post)
      if (error) throw error
    },

    async createReply(postId, reply) {
      const { error } = await supabase.from('replies').insert({ post_id: postId, ...reply })
      if (error) throw error
    },

    async createFeedback(feedback) {
      const { error } = await supabase.from('feedback').insert(feedback)
      if (error) throw error
    },

    async toggleReplyVote(replyId) {
      const { error } = await supabase.rpc('toggle_reply_vote', { p_reply_id: replyId })
      if (error) throw error
    },
  }
}

function createDemoBackend() {
  const listeners = new Set()

  function readData() {
    const stored = window.localStorage.getItem(DEMO_STORAGE_KEY)
    if (!stored) {
      const seeded = initialDemoData()
      window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(seeded))
      return seeded
    }

    try {
      return JSON.parse(stored)
    } catch {
      const seeded = initialDemoData()
      window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(seeded))
      return seeded
    }
  }

  function writeData(data) {
    window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(data))
  }

  function currentSession() {
    return window.localStorage.getItem(DEMO_SESSION_KEY) ? { user: demoUser } : null
  }

  function emit() {
    const session = currentSession()
    for (const listener of listeners) listener(session)
  }

  return {
    isDemo: true,

    async getSession() {
      return currentSession()
    },

    onAuthChange(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },

    async signIn() {
      window.localStorage.setItem(DEMO_SESSION_KEY, '1')
      emit()
    },

    async signOut() {
      window.localStorage.removeItem(DEMO_SESSION_KEY)
      emit()
    },

    // Membership persists across sign-out/sign-in, same as a real
    // `members` row would for a returning Google account.
    async isMember() {
      return window.localStorage.getItem(DEMO_MEMBER_KEY) === '1'
    },

    async redeemInviteCode(code) {
      if (normalizeInviteCode(code) !== DEMO_INVITE_CODE) return false
      window.localStorage.setItem(DEMO_MEMBER_KEY, '1')
      return true
    },

    async listPosts() {
      const data = readData()
      const likedIds = new Set(
        (data.reply_votes || [])
          .filter((vote) => vote.user_id === demoUser.id)
          .map((vote) => Number(vote.reply_id)),
      )

      return data.posts
        .map((post) => ({
          ...post,
          replies: sortReplies(
            data.replies
              .filter((reply) => String(reply.post_id) === String(post.id))
              .map((reply) => withVoteState(reply, likedIds.has(Number(reply.id)))),
          ),
        }))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 50)
    },

    async createPost(post) {
      const data = readData()
      data.posts.unshift({ id: data.nextPostId++, ...post, created_at: new Date().toISOString() })
      writeData(data)
    },

    async createReply(postId, reply) {
      const data = readData()
      const isAnonymous = Boolean(reply.is_anonymous)
      data.replies.push({
        id: data.nextReplyId++,
        post_id: postId,
        author_name: isAnonymous ? '匿名成员' : demoUser.user_metadata.full_name,
        author_avatar_url: '',
        is_anonymous: isAnonymous,
        body: reply.body,
        upvote_count: 0,
        created_at: new Date().toISOString(),
      })
      writeData(data)
    },

    async createFeedback(feedback) {
      const data = readData()
      data.feedback ??= []
      data.nextFeedbackId ??= 1
      data.feedback.push({
        id: data.nextFeedbackId++,
        ...feedback,
        created_at: new Date().toISOString(),
      })
      writeData(data)
    },

    async toggleReplyVote(replyId) {
      const data = readData()
      if (!Array.isArray(data.reply_votes)) data.reply_votes = []

      const reply = data.replies.find((item) => String(item.id) === String(replyId))
      if (!reply) throw new Error('这条回复已经不存在。')

      const existingAt = data.reply_votes.findIndex(
        (vote) => String(vote.reply_id) === String(replyId) && vote.user_id === demoUser.id,
      )

      if (existingAt >= 0) {
        data.reply_votes.splice(existingAt, 1)
        reply.upvote_count = Math.max(0, (Number(reply.upvote_count) || 0) - 1)
      } else {
        data.reply_votes.push({ reply_id: reply.id, user_id: demoUser.id })
        reply.upvote_count = (Number(reply.upvote_count) || 0) + 1
      }

      writeData(data)
    },
  }
}
