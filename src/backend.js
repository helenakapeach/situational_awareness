import { createClient } from '@supabase/supabase-js'
import { LIMITS, normalizeInviteCode, postIdFromSearch, postUrl, sortReplies, withVoteState } from './lib.js'

const DEMO_STORAGE_KEY = 'situational-awareness-demo-v8'
const DEMO_SESSION_KEY = 'situational-awareness-demo-session'
const DEMO_MEMBER_KEY = 'situational-awareness-demo-member'
const DEMO_INVITE_CODE = 'DEMO2026'
const DEMO_PROFILE_KEY = 'situational-awareness-demo-profile'

const DEMO_COHORTS = [
  { id: 1, name: '创业' },
  { id: 2, name: '职业组进阶班' },
  { id: 3, name: '职业组成长版' },
]

function defaultDemoProfile() {
  return {
    public_id: 'demo-user',
    display_name: 'MVP 测试用户',
    tagline: null,
    bio: null,
    avatar_url: '',
    linkedin_url: null,
    linkedin_public: false,
    contact_email: null,
    email_public: false,
    wechat_id: null,
    wechat_public: false,
    role: null,
    cohort_id: null,
    cohort_name: null,
    graduation_year: null,
    role_verified: false,
  }
}

const DEMO_DIRECTORY = {
  'seed-c': {
    public_id: 'seed-c',
    display_name: '林然',
    tagline: '帮人把「要不要接」拆成可以选择的条件',
    bio: '带过几个第一次独立扛项目的人。更关心你有没有把选择权交回去，而不是你接不接。',
    role: 'mentor',
    role_verified: true,
    linkedin_url: 'https://www.linkedin.com/in/example-linran',
    linkedin_public: true,
  },
  'seed-d': {
    public_id: 'seed-d',
    display_name: '周宁',
    tagline: '还在学怎么把反馈说清楚',
    bio: '学员。遇到拿不准的反馈，会先私下说，再看对方要不要把它变成自己的下一版。',
    role: 'student',
    cohort_name: '职业组进阶班',
    graduation_year: 2025,
    wechat_id: 'ZhouNing2025',
    wechat_public: true,
  },
  'seed-w': {
    public_id: 'seed-w',
    display_name: 'Wendy Zhang',
    tagline: '习惯把不同意见说成一个还没解释清楚的现象',
    bio: '其他成员。没有在带人，但愿意把一次难谈的对话拆开。',
    role: 'other',
    // 私密邮箱：卡片上不应该出现
    contact_email: 'wendy@example.com',
    email_public: false,
  },
}

function publicProfileCard(profile, isSelf) {
  const card = {
    public_id: profile.public_id,
    display_name: profile.display_name,
    tagline: profile.tagline,
    bio: profile.bio,
    avatar_url: profile.avatar_url,
    role: profile.role,
    cohort_name: profile.cohort_name,
    graduation_year: profile.graduation_year,
    role_verified: Boolean(profile.role_verified),
    is_self: isSelf,
  }
  if (profile.linkedin_public && profile.linkedin_url) card.linkedin_url = profile.linkedin_url
  if (profile.email_public && profile.contact_email) card.contact_email = profile.contact_email
  if (profile.wechat_public && profile.wechat_id) card.wechat_id = profile.wechat_id
  return card
}

function contentIdentity(profile) {
  if (!profile) {
    return {
      author_name: '匿名成员',
      author_avatar_url: '',
      author_public_id: null,
      author_role: null,
      author_cohort_name: null,
      author_role_verified: false,
    }
  }
  return {
    author_name: profile.display_name,
    author_avatar_url: profile.avatar_url || '',
    author_public_id: profile.public_id,
    author_role: profile.role,
    author_cohort_name: profile.cohort_name,
    author_role_verified: Boolean(profile.role_verified),
  }
}

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
    nextReplyId: 6,
    nextFeedbackId: 1,
    feedback: [],
    posts: [
      {
        id: 2,
        title: '老板让我接一个高曝光项目，但资源明显不够，该接吗？',
        body: '项目能让我接触到更高层，但时间线不现实，而且没有明确的人力支持。我担心接了做砸，不接又像是在躲机会。\n\n背景大概是这样：上周例会上老板当众点名，说这个项目能让业务侧看到我们，也是我第一次有机会和 VP 一起开会。听起来像晋升前的试金石，但细看资源缺口很大。\n\n现在手上已经有两条在跑的线，其中一条下周就要验收。新项目口头说「两周出一版」，实际范围还在涨：要对接三个内部系统，其中两个没有文档，对接人要到下个月才有空。人力上只答应「先做起来再看」，没有明确编制。\n\n我目前在权衡：\n\n- **接**：曝光高，但资源缺口很大，失败会被看见\n- **不接**：保住质量，但可能被看成回避机会\n\n你们会怎么判断？有没有在类似「机会很大、条件很差」的局里站稳过的经验？',
        author_id: 'seed-poster',
        author_name: '匿名成员',
        author_avatar_url: '',
        is_anonymous: true,
        created_at: hoursAgo(2),
        updated_at: null,
        upvote_count: 3,
      },
      {
        id: 1,
        title: '如何告诉同事：他的方案方向可能从一开始就错了？',
        body: '我们关系不错，但他已经在这个方案上投入很多。我有一些用户数据支持不同方向，不想让反馈听起来像是在否定他本人。',
        author_id: 'seed-poster',
        author_name: '匿名成员',
        author_avatar_url: '',
        is_anonymous: true,
        created_at: hoursAgo(27),
        updated_at: null,
        upvote_count: 5,
      },
    ],
    replies: [
      {
        id: 5,
        post_id: 2,
        author_id: 'demo-user',
        author_name: 'MVP 测试用户',
        author_avatar_url: '',
        author_public_id: 'demo-user',
        author_role: null,
        author_cohort_name: null,
        author_role_verified: false,
        is_anonymous: false,
        body: '我先记下自己的判断：接之前把成功条件和资源缺口写成一页，让老板选，而不是口头答应。',
        created_at: hoursAgo(0.5),
        upvote_count: 0,
      },
      {
        id: 3,
        post_id: 2,
        author_id: 'seed-c',
        author_name: '林然',
        author_avatar_url: '',
        author_public_id: 'seed-c',
        author_role: 'mentor',
        author_cohort_name: null,
        author_role_verified: true,
        is_anonymous: false,
        body: '我会先把 **接项目** 和 **接受当前资源条件** 拆开。可以接，但先写成一页请老板选择取舍：\n\n1. 成功条件是什么\n2. 缺哪些人和时间\n3. 做不到时怎么收场\n\n口头答应最容易变成默认你已经接下全部条件。把选择权交回去，既保住机会，也不用一个人扛缺口。如果这一页他不愿意签，那其实已经回答了「该不该接」。',
        created_at: hoursAgo(1),
        upvote_count: 1,
      },
      {
        id: 4,
        post_id: 1,
        author_id: 'seed-d',
        author_name: '周宁',
        author_avatar_url: '',
        author_public_id: 'seed-d',
        author_role: 'student',
        author_cohort_name: '职业组进阶班',
        author_role_verified: false,
        is_anonymous: false,
        body: '如果对方在意面子，可以把数据框成“我们一起还没解释清楚的现象”，让他有空间把方案改成自己的下一版，而不是被当众纠正。\n\n先肯定他已经投入的部分，再把数据当成共同要解释的信号，而不是当场判方案死刑。私下给一版「你来主导下一轮」的台阶，比在会上直接推翻更不容易伤关系。',
        created_at: hoursAgo(10),
        upvote_count: 3,
      },
      {
        id: 2,
        post_id: 1,
        author_id: 'seed-w',
        author_name: 'Wendy Zhang',
        author_avatar_url: '',
        author_public_id: 'seed-w',
        author_role: 'other',
        author_cohort_name: null,
        author_role_verified: false,
        is_anonymous: false,
        body: '先从共同目标切入，再把数据当作一个需要一起解释的新信号，而不是结论。比如：“这组结果和我们的假设不太一样，我们一起看看可能漏掉了什么？”',
        created_at: hoursAgo(18),
        upvote_count: 0,
      },
      {
        id: 1,
        post_id: 1,
        author_id: 'seed-a',
        author_name: '匿名成员',
        author_avatar_url: '',
        is_anonymous: true,
        body: '如果时间允许，可以先私下聊，不要在大会议里第一次提出。给对方保留重新包装方案的空间。\n\n会上第一次摊牌，对方几乎只能防守。私下把数据和你的担心说清楚，让他有时间把方向改成自己的下一版，公开场合就只需要对齐，不必当众认错。关系还能用，方向也有机会被修正。',
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
    post_votes: [
      { post_id: 2, user_id: 'seed-a' },
      { post_id: 2, user_id: 'seed-b' },
      { post_id: 2, user_id: 'seed-c' },
      { post_id: 1, user_id: 'seed-d' },
      { post_id: 1, user_id: 'seed-e' },
      { post_id: 1, user_id: 'seed-f' },
      { post_id: 1, user_id: 'seed-g' },
      { post_id: 1, user_id: 'demo-user' },
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
  return postUrl(window.location.href, postIdFromSearch(window.location.search))
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
    storageBase: url.replace(/\/$/, ''),

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

    async memberAccess() {
      const { data, error } = await supabase.rpc('member_access')
      if (error) throw error
      return data || { is_member: false, is_admin: false, is_disabled: false }
    },
    async adminMembers() {
      const { data, error } = await supabase.rpc('admin_members')
      if (error) throw error
      return data
    },
    async adminSetDisabled(userId, disabled) {
      const { error } = await supabase.rpc('admin_set_disabled', { p_user_id: userId, p_disabled: disabled })
      if (error) throw error
    },
    async adminDeleteContent(id, kind) {
      const { error } = await supabase.rpc('admin_delete_content', { p_id: id, p_kind: kind })
      if (error) throw error
    },
    async adminSetRoleVerified(userId, verified) {
      const { error } = await supabase.rpc('admin_set_role_verified', {
        p_user_id: userId,
        p_verified: verified,
      })
      if (error) throw error
    },

    async getOwnProfile() {
      const { data, error } = await supabase.rpc('get_own_profile')
      if (error) throw error
      return data
    },

    async getProfile(publicId) {
      const { data, error } = await supabase.rpc('get_profile', { p_public_id: publicId })
      if (error) throw error
      return data
    },

    async listCohorts() {
      const { data, error } = await supabase
        .from('cohorts')
        .select('id,name')
        .order('sort_order', { ascending: true })
      if (error) throw error
      return data || []
    },

    async updateOwnProfile(profile) {
      const { data, error } = await supabase.rpc('update_own_profile', { p_profile: profile })
      if (error) throw error
      return data
    },

    async uploadAvatar(blob) {
      const reserved = await supabase.rpc('reserve_avatar_upload')
      if (reserved.error) throw reserved.error
      const uploaded = await supabase.storage.from('avatars').upload(reserved.data, blob, {
        contentType: 'image/webp',
        upsert: false,
      })
      if (uploaded.error) throw uploaded.error
      const confirmed = await supabase.rpc('confirm_avatar_upload')
      if (confirmed.error) throw confirmed.error
      return confirmed.data
    },

    async clearAvatar() {
      const { data, error } = await supabase.rpc('clear_avatar')
      if (error) throw error
      return data
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

    // 游标用 created_at 而不是 offset：翻页过程中有人发帖也不会让某一条
    // 被挤到下一页而漏掉，或者重复出现一次。
    // Ownership comes from a scoped RPC, without exposing author_id or
    // requiring SELECT on the whole row for a PostgREST computed field.
    async listPosts({ before = null } = {}) {
      let query = supabase
        .from('posts')
        .select('id,author_name,author_avatar_url,author_public_id,author_role,author_cohort_name,author_role_verified,is_anonymous,title,body,created_at,updated_at,upvote_count,post_votes(post_id)')
        .order('created_at', { ascending: false })
        .limit(LIMITS.pageSize)

      if (before) query = query.lt('created_at', before)

      const { data: posts, error: postsError } = await query

      if (postsError) throw postsError
      if (!posts.length) return []

      const { data: replies, error: repliesError } = await supabase
        .from('replies')
        .select('id,post_id,parent_reply_id,author_name,author_avatar_url,author_public_id,author_role,author_cohort_name,author_role_verified,is_anonymous,body,created_at,updated_at,upvote_count,reply_votes(reply_id)')
        .in('post_id', posts.map((post) => post.id))

      if (repliesError) throw repliesError

      const { data: ownership, error: ownershipError } = await supabase.rpc('own_content_ids', {
        p_post_ids: posts.map((post) => post.id),
      })
      if (ownershipError) throw ownershipError
      const ownPosts = new Set((ownership?.posts || []).map(String))
      const ownReplies = new Set((ownership?.replies || []).map(String))

      const repliesByPost = new Map()
      for (const { reply_votes, ...reply } of replies || []) {
        const key = String(reply.post_id)
        if (!repliesByPost.has(key)) repliesByPost.set(key, [])
        repliesByPost
          .get(key)
          .push(withVoteState({ ...reply, is_mine: ownReplies.has(String(reply.id)) }, reply_votes && reply_votes.length > 0))
      }

      return posts.map(({ post_votes, ...post }) => ({
        ...withVoteState({ ...post, is_mine: ownPosts.has(String(post.id)) }, post_votes && post_votes.length > 0),
        replies: sortReplies(repliesByPost.get(String(post.id)) || []),
      }))
    },

    async listLiked() {
      const [{ data: postVotes, error: postError }, { data: replyVotes, error: replyError }] = await Promise.all([
        supabase
          .from('post_votes')
          .select('posts(id,title,created_at,is_anonymous,author_name)')
          .limit(100),
        supabase
          .from('reply_votes')
          .select('replies(id,post_id,body,created_at,is_anonymous,author_name,posts(id,title))')
          .limit(100),
      ])
      if (postError) throw postError
      if (replyError) throw replyError

      const byNewest = (left, right) => new Date(right.created_at) - new Date(left.created_at)
      return {
        posts: (postVotes || []).map((vote) => vote.posts).filter(Boolean).sort(byNewest),
        replies: (replyVotes || [])
          .map((vote) => vote.replies)
          .filter((reply) => reply?.posts)
          .map(({ posts, ...reply }) => ({ ...reply, post_title: posts.title }))
          .sort(byNewest),
      }
    },

    async createPost(post) {
      const { error } = await supabase.from('posts').insert(post)
      if (error) throw error
    },

    async updatePost(postId, post) {
      const { data, error } = await supabase
        .from('posts')
        .update(post)
        .eq('id', postId)
        .select('id')

      if (error) throw error
      if (!data?.length) throw new Error('这条讨论已经不存在，或不是你的。')
    },

    async deletePost(postId) {
      const { error } = await supabase.rpc('delete_own_post', { p_post_id: postId })
      if (error) throw error
    },

    async createReply(postId, reply) {
      const { error } = await supabase.from('replies').insert({ post_id: postId, ...reply })
      if (error) throw error
    },

    async updateReply(replyId, body) {
      const { data, error } = await supabase
        .from('replies')
        .update({ body })
        .eq('id', replyId)
        .select('id')

      if (error) throw error
      if (!data?.length) throw new Error('这条回复已经不存在，或不是你的。')
    },

    async deleteReply(replyId) {
      const { data, error } = await supabase
        .from('replies')
        .delete()
        .eq('id', replyId)
        .select('id')

      if (error) throw error
      if (!data?.length) throw new Error('这条回复已经不存在，或不是你的。')
    },

    async createFeedback(feedback) {
      const { error } = await supabase.from('feedback').insert(feedback)
      if (error) throw error
    },

    async toggleReplyVote(replyId) {
      const { error } = await supabase.rpc('toggle_reply_vote', { p_reply_id: replyId })
      if (error) throw error
    },

    async togglePostVote(postId) {
      const { error } = await supabase.rpc('toggle_post_vote', { p_post_id: postId })
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

  function readProfile() {
    const stored = window.localStorage.getItem(DEMO_PROFILE_KEY)
    if (!stored) return defaultDemoProfile()
    try {
      return { ...defaultDemoProfile(), ...JSON.parse(stored) }
    } catch {
      return defaultDemoProfile()
    }
  }

  function saveProfile(profile) {
    const cohort = DEMO_COHORTS.find((item) => item.id === profile.cohort_id)
    const next = { ...profile, cohort_name: cohort?.name ?? null }
    window.localStorage.setItem(DEMO_PROFILE_KEY, JSON.stringify(next))
    const data = readData()
    const identity = contentIdentity(next)
    for (const row of [...data.posts, ...data.replies]) {
      if (row.author_id === demoUser.id && !row.is_anonymous) Object.assign(row, identity)
    }
    writeData(data)
    return { ...next, is_self: true }
  }

  return {
    isDemo: true,
    storageBase: '',

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
    async memberAccess() {
      return { is_member: window.localStorage.getItem(DEMO_MEMBER_KEY) === '1', is_admin: false, is_disabled: false }
    },

    async isMember() {
      return window.localStorage.getItem(DEMO_MEMBER_KEY) === '1'
    },

    async redeemInviteCode(code) {
      if (normalizeInviteCode(code) !== DEMO_INVITE_CODE) return false
      window.localStorage.setItem(DEMO_MEMBER_KEY, '1')
      return true
    },

    async getOwnProfile() {
      return { ...readProfile(), is_self: true }
    },

    async getProfile(publicId) {
      if (publicId === 'demo-user') return publicProfileCard(await this.getOwnProfile(), true)
      const profile = DEMO_DIRECTORY[publicId]
      return profile ? publicProfileCard(profile, false) : null
    },

    async listCohorts() {
      return DEMO_COHORTS.map((cohort) => ({ ...cohort }))
    },

    async updateOwnProfile(profile) {
      const current = readProfile()
      const sameRole = current.role === profile.role && current.cohort_id === profile.cohort_id
      return saveProfile({
        ...current,
        ...profile,
        role_verified: sameRole && current.role_verified,
      })
    },

    async uploadAvatar(blob) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('头像读取失败。'))
        reader.readAsDataURL(blob)
      })
      return saveProfile({ ...readProfile(), avatar_url: dataUrl })
    },

    async clearAvatar() {
      return saveProfile({ ...readProfile(), avatar_url: '' })
    },

    async listPosts({ before = null } = {}) {
      const data = readData()
      const likedReplyIds = new Set(
        (data.reply_votes || [])
          .filter((vote) => vote.user_id === demoUser.id)
          .map((vote) => Number(vote.reply_id)),
      )
      const likedPostIds = new Set(
        (data.post_votes || [])
          .filter((vote) => vote.user_id === demoUser.id)
          .map((vote) => Number(vote.post_id)),
      )

      const cutoff = before ? new Date(before).getTime() : null

      return data.posts
        .slice()
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .filter((post) => cutoff === null || new Date(post.created_at).getTime() < cutoff)
        .slice(0, LIMITS.pageSize)
        .map((post) => {
          const { author_id, ...rest } = post
          const isAnonymous = post.is_anonymous !== false
          return {
            ...withVoteState(
              {
                ...rest,
                ...(isAnonymous && contentIdentity(null)),
                is_anonymous: isAnonymous,
                is_mine: author_id === demoUser.id,
              },
              likedPostIds.has(Number(post.id)),
            ),
            replies: sortReplies(
              data.replies
                .filter((reply) => String(reply.post_id) === String(post.id))
                .map((reply) => {
                  const { author_id: replyAuthorId, ...replyRest } = reply
                  return withVoteState(
                    {
                      ...replyRest,
                      ...(reply.is_anonymous && contentIdentity(null)),
                      is_mine: replyAuthorId === demoUser.id,
                    },
                    likedReplyIds.has(Number(reply.id)),
                  )
                }),
            ),
          }
        })
    },

    async listLiked() {
      const data = readData()
      const likedPostIds = new Set(
        (data.post_votes || [])
          .filter((vote) => vote.user_id === demoUser.id)
          .map((vote) => String(vote.post_id)),
      )
      const likedReplyIds = new Set(
        (data.reply_votes || [])
          .filter((vote) => vote.user_id === demoUser.id)
          .map((vote) => String(vote.reply_id)),
      )
      const byNewest = (left, right) => new Date(right.created_at) - new Date(left.created_at)
      return {
        posts: data.posts
          .filter((post) => likedPostIds.has(String(post.id)))
          .map((post) => ({
            id: post.id,
            title: post.title,
            created_at: post.created_at,
            is_anonymous: post.is_anonymous !== false,
            author_name: post.author_name,
          }))
          .sort(byNewest),
        replies: data.replies
          .filter((reply) => likedReplyIds.has(String(reply.id)))
          .map((reply) => ({
            id: reply.id,
            post_id: reply.post_id,
            body: reply.body,
            created_at: reply.created_at,
            is_anonymous: Boolean(reply.is_anonymous),
            author_name: reply.author_name,
            post_title: data.posts.find((post) => String(post.id) === String(reply.post_id))?.title || '这条讨论',
          }))
          .sort(byNewest),
      }
    },

    async createPost(post) {
      const data = readData()
      const isAnonymous = post.is_anonymous !== false
      data.posts.unshift({
        id: data.nextPostId++,
        ...post,
        author_id: demoUser.id,
        ...contentIdentity(isAnonymous ? null : readProfile()),
        is_anonymous: isAnonymous,
        upvote_count: 0,
        created_at: new Date().toISOString(),
        updated_at: null,
      })
      writeData(data)
    },

    async updatePost(postId, next) {
      const data = readData()
      const post = data.posts.find((item) => String(item.id) === String(postId))
      if (!post || post.author_id !== demoUser.id) {
        throw new Error('这条讨论已经不存在，或不是你的。')
      }
      post.title = next.title
      post.body = next.body
      post.updated_at = new Date().toISOString()
      writeData(data)
    },

    async deletePost(postId) {
      const data = readData()
      const post = data.posts.find((item) => String(item.id) === String(postId))
      if (!post || post.author_id !== demoUser.id) {
        throw new Error('这条讨论已经不存在，或不是你的。')
      }
      const id = String(postId)
      const replyIds = new Set(
        data.replies.filter((reply) => String(reply.post_id) === id).map((reply) => String(reply.id)),
      )
      data.posts = data.posts.filter((item) => String(item.id) !== id)
      data.replies = data.replies.filter((reply) => String(reply.post_id) !== id)
      data.reply_votes = (data.reply_votes || []).filter((vote) => !replyIds.has(String(vote.reply_id)))
      data.post_votes = (data.post_votes || []).filter((vote) => String(vote.post_id) !== id)
      writeData(data)
    },

    async createReply(postId, reply) {
      const data = readData()
      const isAnonymous = Boolean(reply.is_anonymous)
      const parent = reply.parent_reply_id == null ? null : data.replies.find(item => String(item.id) === String(reply.parent_reply_id))
      if (reply.parent_reply_id != null && (!parent || String(parent.post_id) !== String(postId))) {
        throw new Error('要回复的评论已经不存在。')
      }
      data.replies.push({
        id: data.nextReplyId++,
        post_id: postId,
        parent_reply_id: parent?.id ?? null,
        author_id: demoUser.id,
        ...contentIdentity(isAnonymous ? null : readProfile()),
        is_anonymous: isAnonymous,
        body: reply.body,
        upvote_count: 0,
        created_at: new Date().toISOString(),
        updated_at: null,
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

    async togglePostVote(postId) {
      const data = readData()
      if (!Array.isArray(data.post_votes)) data.post_votes = []

      const post = data.posts.find((item) => String(item.id) === String(postId))
      if (!post) throw new Error('这条讨论已经不存在。')

      const existingAt = data.post_votes.findIndex(
        (vote) => String(vote.post_id) === String(postId) && vote.user_id === demoUser.id,
      )

      if (existingAt >= 0) {
        data.post_votes.splice(existingAt, 1)
        post.upvote_count = Math.max(0, (Number(post.upvote_count) || 0) - 1)
      } else {
        data.post_votes.push({ post_id: post.id, user_id: demoUser.id })
        post.upvote_count = (Number(post.upvote_count) || 0) + 1
      }

      writeData(data)
    },

    async updateReply(replyId, body) {
      const data = readData()
      const reply = data.replies.find((item) => String(item.id) === String(replyId))
      if (!reply || reply.author_id !== demoUser.id) {
        throw new Error('这条回复已经不存在，或不是你的。')
      }
      reply.body = body
      reply.updated_at = new Date().toISOString()
      writeData(data)
    },

    async deleteReply(replyId) {
      const data = readData()
      const reply = data.replies.find((item) => String(item.id) === String(replyId))
      if (!reply || reply.author_id !== demoUser.id) {
        throw new Error('这条回复已经不存在，或不是你的。')
      }
      data.replies = data.replies.filter((item) => String(item.id) !== String(replyId)).map(item =>
        String(item.parent_reply_id) === String(replyId) ? { ...item, parent_reply_id: null } : item,
      )
      data.reply_votes = (data.reply_votes || []).filter(
        (vote) => String(vote.reply_id) !== String(replyId),
      )
      writeData(data)
    },
  }
}
