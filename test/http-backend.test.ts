import test from 'node:test'
import assert from 'node:assert/strict'
import { createHttpBackend } from '../src/http-backend.ts'
import type { HttpRequestInit } from '../src/http-backend.ts'
import type { AppSession } from '../src/types.ts'

function authStub(initialSession: AppSession | null) {
  let session = initialSession
  const listeners = new Set<(event: string, session: AppSession | null) => void>()
  return {
    auth: {
      async getSession() { return { data: { session }, error: null } },
      onAuthStateChange(callback: (event: string, session: AppSession | null) => void) {
        listeners.add(callback)
        return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } }
      },
      signInOptions: undefined as { provider: string; options: { redirectTo: string } } | undefined,
      async signInWithOAuth(options: { provider: string; options: { redirectTo: string } }) { this.signInOptions = options; return { error: null } },
      async signOut() { session = null; for (const listener of listeners) listener('SIGNED_OUT', null); return { error: null } },
      emit(event: string, nextSession: AppSession | null) { session = nextSession; for (const listener of listeners) listener(event, session) },
    },
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(payload == null ? '' : JSON.stringify(payload), { status })
}

test('exchanges Supabase session lazily and sends the app JWT on API requests', async () => {
  const supabase = authStub({ access_token: 'supabase-1', user: { id: 'u1', email: 'a@b.test', user_metadata: { name: 'A' } } })
  const calls: Array<{ url: string; init: HttpRequestInit }> = []
  const backend = createHttpBackend({
    baseUrl: 'http://localhost:26276/', auth: supabase.auth,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return url.endsWith('/api/auth/session')
        ? jsonResponse({ accessToken: 'app-jwt', tokenType: 'bearer', expiresIn: 600, user: { id: 'u1', email: 'a@b.test', user_metadata: { name: 'A' } } })
        : jsonResponse({ is_member: true })
    },
  })

  assert.equal(backend.storageBase, 'http://localhost:26276')
  const session = await backend.getSession()
  assert.equal(session?.app_access_token, 'app-jwt')
  assert.deepEqual(await backend.memberAccess(), { is_member: true })
  assert.equal(calls.filter((call) => call.url.endsWith('/api/auth/session')).length, 1)
  assert.equal(calls[1]?.init.headers.get('Authorization'), 'Bearer app-jwt')
})

test('maps API methods and sends avatar bytes with the expected content type', async () => {
  const calls: Array<{ url: string; init: HttpRequestInit }> = []
  const backend = createHttpBackend({
    baseUrl: 'http://api.test', auth: authStub({ access_token: 'supabase', user: { id: 'u1' } }).auth,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/auth/session')) return jsonResponse({ accessToken: 'app-jwt', expiresIn: 600, user: { id: 'u1' } })
      calls.push({ url, init })
      return jsonResponse({ ok: true })
    },
  })
  await backend.listPosts({ before: '2026-10-01T00:00:00Z', before_id: 42 })
  await backend.updateReply('reply/3', 'updated')
  const blob = new Blob(['webp'])
  await backend.uploadAvatar(blob)

  assert.equal(calls[0].url, 'http://api.test/api/posts?before=2026-10-01T00%3A00%3A00Z&before_id=42')
  assert.equal(calls[1].url, 'http://api.test/api/replies/reply%2F3')
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { body: 'updated' })
  assert.equal(calls[2].url, 'http://api.test/api/profile/avatar')
  assert.equal(calls[2]?.init.headers.get('Content-Type'), 'image/webp')
  assert.equal(calls[2]?.init.body, blob)
})

test('search and my content use only authenticated Mongo API routes with safe query encoding', async () => {
  const calls: Array<{ url: string; init: HttpRequestInit }> = []
  const posts = [{ id: 42, title: '工作', replies: [] }]
  const mine = { posts: [{ id: 42 }], replies: [{ id: 9, post_id: 42 }] }
  const backend = createHttpBackend({
    baseUrl: 'https://api.test', auth: authStub({ access_token: 'supabase', user: { id: 'u1' } }).auth,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/auth/session')) return jsonResponse({ accessToken: 'app-jwt', expiresIn: 600, user: { id: 'u1' } })
      calls.push({ url, init })
      return jsonResponse(url.includes('/api/posts/search?') ? posts : mine)
    },
  })
  const term = '工作 &?q=else#%_.*'
  assert.deepEqual(await backend.searchPosts(term), posts)
  assert.deepEqual(await backend.listMine(), mine)
  assert.equal(new URL(calls[0].url).pathname, '/api/posts/search')
  assert.deepEqual([...new URL(calls[0].url).searchParams], [['q', term]])
  assert.equal(calls[1].url, 'https://api.test/api/me/content')
  assert.ok(calls.every(({ init }) => init.headers.get('Authorization') === 'Bearer app-jwt'))
})

test('auth changes exchange before notifying the app and handle token changes', async () => {
  const supabase = authStub({ access_token: 'first', user: { id: 'u1' } })
  const exchanges: string[] = []
  const backend = createHttpBackend({
    baseUrl: 'http://api.test', auth: supabase.auth,
    fetchImpl: async (_url, init) => {
      const token = JSON.parse(String(init.body)).access_token
      exchanges.push(token)
      return jsonResponse({ accessToken: `jwt-${token}`, expiresIn: 600, user: { id: 'u1' } })
    },
  })
  const observed: Array<string | null> = []
  backend.onAuthChange((session) => observed.push(session?.app_access_token || null))
  supabase.auth.emit('TOKEN_REFRESHED', { access_token: 'second', user: { id: 'u1' } })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(exchanges, ['second'])
  assert.deepEqual(observed, ['jwt-second'])
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('late exchange cannot restore a session after sign out', async () => {
  const supabase = authStub(null)
  const pending = deferred<Response>()
  const observed: Array<string | null> = []
  const backend = createHttpBackend({
    baseUrl: 'http://api.test', auth: supabase.auth,
    fetchImpl: () => pending.promise,
  })
  backend.onAuthChange((session) => observed.push(session?.app_access_token || null))
  supabase.auth.emit('SIGNED_IN', { access_token: 'old', user: { id: 'u1' } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await backend.signOut()
  await new Promise((resolve) => setTimeout(resolve, 5))
  pending.resolve(jsonResponse({ accessToken: 'old-jwt', expiresIn: 600, user: { id: 'u1' } }))
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(observed, [null])
  assert.equal(await backend.getSession(), null)
})

test('old pending mutation is canceled after switching to another auth session', async () => {
  const supabase = authStub(null)
  const oldExchange = deferred<Response>()
  const newExchange = deferred<Response>()
  const dataRequests: Array<{ url: string; init: HttpRequestInit }> = []
  const backend = createHttpBackend({
    baseUrl: 'http://api.test', auth: supabase.auth,
    fetchImpl: (url, init) => {
      if (!url.endsWith('/api/auth/session')) {
        dataRequests.push({ url, init })
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      const token = JSON.parse(String(init.body)).access_token
      return token === 'old-user' ? oldExchange.promise : newExchange.promise
    },
  })
  backend.onAuthChange(() => {})
  supabase.auth.emit('SIGNED_IN', { access_token: 'old-user', user: { id: 'old' } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const oldMutation = backend.createPost({ title: 'private to old user', body: '', is_anonymous: true })
  const oldMutationRejection = assert.rejects(oldMutation, /Sign in is required/)
  await new Promise((resolve) => setTimeout(resolve, 5))
  supabase.auth.emit('SIGNED_IN', { access_token: 'new-user', user: { id: 'new' } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  newExchange.resolve(jsonResponse({ accessToken: 'new-user-jwt', expiresIn: 600, user: { id: 'new' } }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  oldExchange.resolve(jsonResponse({ accessToken: 'old-user-jwt', expiresIn: 600, user: { id: 'old' } }))

  await oldMutationRejection
  assert.deepEqual(dataRequests, [])
})

test('signed out API requests fail locally without sending a request', async () => {
  const calls: string[] = []
  const backend = createHttpBackend({
    baseUrl: 'http://api.test', auth: authStub(null).auth,
    fetchImpl: async (url) => { calls.push(url); return jsonResponse({ ok: true }) },
  })
  await assert.rejects(backend.getOwnProfile(), /Sign in is required/)
  assert.deepEqual(calls, [])
})

test('OAuth redirect keeps the explicit Mongo backend and requested post', async () => {
  const originalWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: 'https://app.example/?backend=mongo&post=42', search: '?backend=mongo&post=42' } } })
  try {
    const supabase = authStub(null)
    const backend = createHttpBackend({ baseUrl: 'https://api.example', auth: supabase.auth, fetchImpl: async () => jsonResponse({}) })
    await backend.signIn()
    assert.equal(supabase.auth.signInOptions?.options.redirectTo, 'https://app.example/?backend=mongo&post=42')
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }
})

test('out of order auth exchanges only publish the newest token session', async () => {
  const supabase = authStub(null)
  const first = deferred<Response>()
  const second = deferred<Response>()
  const observed: Array<string | null> = []
  const backend = createHttpBackend({
    baseUrl: 'http://api.test', auth: supabase.auth,
    fetchImpl: (_url, init) => JSON.parse(String(init.body)).access_token === 'first' ? first.promise : second.promise,
  })
  backend.onAuthChange((session) => observed.push(session?.app_access_token || null))
  supabase.auth.emit('SIGNED_IN', { access_token: 'first', user: { id: 'u1' } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  supabase.auth.emit('TOKEN_REFRESHED', { access_token: 'second', user: { id: 'u1' } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  second.resolve(jsonResponse({ accessToken: 'jwt-second', expiresIn: 600, user: { id: 'u1' } }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  first.resolve(jsonResponse({ accessToken: 'jwt-first', expiresIn: 600, user: { id: 'u1' } }))
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(observed, ['jwt-second'])
  assert.equal((await backend.getSession())?.app_access_token, 'jwt-second')
})

test('renews the app token when its returned lifetime expires', async () => {
  const supabase = authStub({ access_token: 'same', user: { id: 'u1' } })
  let exchanges = 0
  const backend = createHttpBackend({
    baseUrl: 'http://api.test', auth: supabase.auth,
    fetchImpl: async () => jsonResponse({ accessToken: `jwt-${++exchanges}`, expiresIn: 1, user: { id: 'u1' } }),
  })
  const originalNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    assert.equal((await backend.getSession())?.app_access_token, 'jwt-1')
    now += 2_000
    assert.equal((await backend.getSession())?.app_access_token, 'jwt-2')
    assert.equal(exchanges, 2)
  } finally {
    Date.now = originalNow
  }
})

test('unsubscribe suppresses a pending auth callback', async () => {
  const supabase = authStub(null)
  const pending = deferred<Response>()
  const observed: unknown[] = []
  const backend = createHttpBackend({ baseUrl: 'http://api.test', auth: supabase.auth, fetchImpl: () => pending.promise })
  const unsubscribe = backend.onAuthChange((session) => observed.push(session))
  supabase.auth.emit('SIGNED_IN', { access_token: 'token', user: { id: 'u1' } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  unsubscribe()
  pending.resolve(jsonResponse({ accessToken: 'jwt', expiresIn: 600, user: { id: 'u1' } }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(observed, [])
})

test('surfaces API errors with FastAPI detail', async () => {
  const backend = createHttpBackend({
    baseUrl: 'http://api.test', auth: authStub({ access_token: 'token', user: { id: 'u1' } }).auth,
    fetchImpl: async (url) => url.endsWith('/api/auth/session')
      ? jsonResponse({ accessToken: 'jwt', expiresIn: 600, user: { id: 'u1' } })
      : jsonResponse({ detail: 'forbidden' }, 403),
  })
  await assert.rejects(backend.getOwnProfile(), /forbidden/)
})
