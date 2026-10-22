import { postIdFromSearch, postUrl } from './lib.ts'
import type { AppSession, Cohort, HttpBackend, HttpLikedContent, HttpMember, HttpMineContent, HttpOwnProfile, HttpPost, HttpPublicProfileCard, ProfileUpdateRequest } from './types.ts'

interface SessionExchangeResponse {
  accessToken: string
  tokenType: 'Bearer'
  expiresIn: number
  user: { id: string; email: string; user_metadata: NonNullable<AppSession['user']['user_metadata']> }
}
interface AuthPort {
  getSession(): Promise<{ data: { session: AppSession | null }; error: Error | null }>
  onAuthStateChange(callback: (event: string, session: AppSession | null) => void): { data: { subscription: { unsubscribe(): void } } }
  signInWithOAuth(options: { provider: 'google'; options: { redirectTo: string } }): Promise<{ error: Error | null }>
  signOut(): Promise<{ error: Error | null }>
}
export interface HttpRequestInit {
  method: string
  headers: HeadersInit
  body?: string | Blob
}

/** HTTP adapter for FastAPI. Supabase is used only for Google OAuth. */
export function createHttpBackend({ baseUrl, auth, fetchImpl = fetch as (url: string, init: HttpRequestInit) => Promise<Response> }: { baseUrl: string; auth: AuthPort; fetchImpl?: (url: string, init: HttpRequestInit) => Promise<Response> }): HttpBackend {
  const apiBase = String(baseUrl || '').replace(/\/+$/, '')
  let appSession: AppSession | null = null
  let exchangedSupabaseToken: string | null = null
  let exchangePromise: { token: string; generation: number; promise: Promise<AppSession | null> } | null = null
  let appTokenExpiresAt = 0
  let authGeneration = 0

  async function exchange(session: AppSession | null, generation = authGeneration) {
    if (generation !== authGeneration) return null
    const accessToken = session?.access_token
    if (!accessToken) {
      if (generation === authGeneration) {
        appSession = null
        exchangedSupabaseToken = null
        appTokenExpiresAt = 0
      }
      return null
    }
    if (accessToken === exchangedSupabaseToken && appSession && Date.now() < appTokenExpiresAt - 30_000) {
      return appSession
    }
    if (exchangePromise?.token === accessToken && exchangePromise.generation === generation) return exchangePromise.promise

    const promise = (async () => {
      const response = await fetchImpl(`${apiBase}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: accessToken, provider: 'supabase' }),
      })
      const result = await readResponse(response) as SessionExchangeResponse
      if (!result?.accessToken) throw new Error('API session response is missing accessToken')
      const nextSession = {
        ...session,
        user: {
          ...session.user,
          id: result.user?.id ?? session.user?.id,
          email: result.user?.email ?? session.user?.email,
          user_metadata: result.user?.user_metadata ?? session.user?.user_metadata ?? {},
        },
        app_access_token: result.accessToken,
        app_token_type: result.tokenType || 'bearer',
      }
      if (generation === authGeneration) {
        exchangedSupabaseToken = accessToken
        appTokenExpiresAt = Date.now() + (Number(result.expiresIn) || 3600) * 1000
        appSession = nextSession
      }
      return generation === authGeneration ? nextSession : null
    })()
    exchangePromise = { token: accessToken, generation, promise }
    try {
      return await promise
    } catch (error) {
      if (generation === authGeneration) {
        appSession = null
        exchangedSupabaseToken = null
        appTokenExpiresAt = 0
      }
      throw error
    } finally {
      if (exchangePromise?.promise === promise) exchangePromise = null
    }
  }

  async function currentSession() {
    const generation = authGeneration
    const { data, error } = await auth.getSession()
    if (error) throw error
    if (generation !== authGeneration) return null
    return exchange(data.session, generation)
  }

  async function request<T>(path: string, { method = 'GET', body, headers = {} }: { method?: string; body?: unknown; headers?: HeadersInit } = {}): Promise<T> {
    const session = await currentSession()
    if (!session?.app_access_token) throw new Error('Sign in is required to use the API.')
    const requestHeaders = new Headers(headers)
    if (body !== undefined && !(body instanceof Blob) && !requestHeaders.has('Content-Type')) {
      requestHeaders.set('Content-Type', 'application/json')
    }
    if (body instanceof Blob && !requestHeaders.has('Content-Type')) requestHeaders.set('Content-Type', 'image/webp')
    if (session?.app_access_token) requestHeaders.set('Authorization', `Bearer ${session.app_access_token}`)
    const response = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: body instanceof Blob ? body : JSON.stringify(body) }),
    })
    return await readResponse(response) as T
  }

  return {
    mode: 'mongo',
    isDemo: false,
    storageBase: apiBase,
    async getSession() { return currentSession() },
    onAuthChange(callback) {
      let active = true
      const { data } = auth.onAuthStateChange((_event, session) => {
        // Never await network work while Supabase holds its auth lock.
        const generation = ++authGeneration
        setTimeout(() => {
          if (!active || generation !== authGeneration) return
          exchange(session, generation).then((nextSession) => {
            if (active && generation === authGeneration) callback(nextSession)
          }).catch((error) => {
            if (!active || generation !== authGeneration) return
            appSession = null
            exchangedSupabaseToken = null
            appTokenExpiresAt = 0
            console.error('Could not exchange Supabase session with API', error)
            callback(null)
          })
        })
      })
      return () => {
        active = false
        data.subscription.unsubscribe()
      }
    },
    async signIn() {
      const { error } = await auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: postUrl(window.location.href, postIdFromSearch(window.location.search)) },
      })
      if (error) throw error
    },
    async signOut() {
      const generationBeforeSignOut = authGeneration
      const { error } = await auth.signOut()
      if (error) throw error
      if (authGeneration === generationBeforeSignOut) authGeneration += 1
      appSession = null
      exchangedSupabaseToken = null
      appTokenExpiresAt = 0
    },
    async memberAccess() { return (await request<{ is_member: boolean; is_admin: boolean; is_disabled: boolean }>('/api/member-access')) || { is_member: false, is_admin: false, is_disabled: false } },
    async adminMembers() { return request<HttpMember[]>('/api/admin/members') },
    async adminSetDisabled(userId, disabled) { await request<null>(`/api/admin/members/${id(userId)}`, { method: 'PATCH', body: { is_disabled: disabled } }) },
    async adminDeleteContent(contentId, kind) { await request<null>(`/api/admin/content/${id(kind)}/${id(contentId)}`, { method: 'DELETE' }) },
    async adminSetRoleVerified(userId, verified) { await request<null>(`/api/admin/members/${id(userId)}/role-verification`, { method: 'PUT', body: { verified } }) },
    async getPost(postId) { return request<HttpPost>(`/api/posts/${id(postId)}`) },
    async getOwnProfile() { return request<HttpOwnProfile>('/api/profile') },
    async getProfile(publicId) { return request<HttpPublicProfileCard | null>(`/api/profiles/${id(publicId)}`) },
    async listCohorts() { return (await request<Cohort[]>('/api/cohorts')) || [] },
    async updateOwnProfile(profile: ProfileUpdateRequest) { return request<HttpOwnProfile>('/api/profile', { method: 'PUT', body: profile }) },
    async uploadAvatar(blob) { return request<HttpOwnProfile>('/api/profile/avatar', { method: 'POST', body: blob, headers: { 'Content-Type': 'image/webp' } }) },
    async clearAvatar() { return request<HttpOwnProfile>('/api/profile/avatar', { method: 'DELETE' }) },
    async isMember() { return Boolean((await request<{ is_member: boolean }>('/api/member-access'))?.is_member) },
    async redeemInviteCode(code) { return Boolean(await request<boolean>('/api/invite-redemptions', { method: 'POST', body: { code } })) },
    async listPosts({ before = null, before_id = null } = {}) {
      const query = new URLSearchParams()
      if (before) query.set('before', before)
      if (before_id != null) query.set('before_id', String(before_id))
      return (await request<HttpPost[]>(`/api/posts${query.size ? `?${query}` : ''}`)) || []
    },
    async searchPosts(term) {
      const query = new URLSearchParams({ q: String(term ?? '') })
      return (await request<HttpPost[]>(`/api/posts/search?${query}`)) || []
    },
    async listMine() { return (await request<HttpMineContent>('/api/me/content')) || { posts: [], replies: [] } },
    async createPost(post) { await request<null>('/api/posts', { method: 'POST', body: post }) },
    async updatePost(postId, post) { await request<null>(`/api/posts/${id(postId)}`, { method: 'PATCH', body: post }) },
    async deletePost(postId) { await request<null>(`/api/posts/${id(postId)}`, { method: 'DELETE' }) },
    async createReply(postId, reply) { await request<null>(`/api/posts/${id(postId)}/replies`, { method: 'POST', body: reply }) },
    async updateReply(replyId, body) { await request<null>(`/api/replies/${id(replyId)}`, { method: 'PATCH', body: { body } }) },
    async deleteReply(replyId) { await request<null>(`/api/replies/${id(replyId)}`, { method: 'DELETE' }) },
    async togglePostVote(postId) { await request<null>(`/api/posts/${id(postId)}/vote`, { method: 'POST' }) },
    async toggleReplyVote(replyId) { await request<null>(`/api/replies/${id(replyId)}/vote`, { method: 'POST' }) },
    async listLiked() { return (await request<HttpLikedContent>('/api/likes')) || { posts: [], replies: [] } },
    async createFeedback(feedback) { await request<null>('/api/feedback', { method: 'POST', body: feedback }) },
  }
}

function id(value: string | number) { return encodeURIComponent(String(value)) }

async function readResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return null
  const text = await response.text()
  let payload = null
  if (text) {
    try { payload = JSON.parse(text) } catch { payload = text }
  }
  if (!response.ok) {
    const message = typeof payload === 'string' ? payload : payload?.detail || payload?.message || `Request failed (${response.status})`
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message))
  }
  return payload
}
