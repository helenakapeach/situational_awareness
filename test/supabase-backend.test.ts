import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseBackend } from '../src/backend.ts'

interface MockResult { data: unknown; error: Error | null }
interface MockCall {
  type: 'rpc' | 'query' | 'upload'
  name?: string
  args?: unknown[] | Record<string, unknown>
  table?: string
  method?: string
  bucket?: string
  path?: string
  blob?: Blob
  options?: unknown
}
interface MockQuery {
  (...args: unknown[]): MockQuery
  [key: string]: unknown
  then: Promise<MockResult>['then']
}

function createSupabaseMock({
  rpc = {},
  tables = {},
  uploadResult = { data: {}, error: null },
}: {
  rpc?: Record<string, MockResult | ((args: unknown) => MockResult)>
  tables?: Record<string, MockResult[]>
  uploadResult?: MockResult
} = {}) {
  const calls: MockCall[] = []
  const tableReads = new Map<string, number>()
  const client = {
    calls,
    rpc(name: string, args?: Record<string, unknown>) {
      calls.push({ type: 'rpc', name, args })
      const response = rpc[name] ?? { data: null, error: null }
      return Promise.resolve(typeof response === 'function' ? response(args) : response)
    },
    from(table: string) {
      const index = tableReads.get(table) || 0
      tableReads.set(table, index + 1)
      const result = (tables[table] || [])[index] ?? { data: [], error: null }
      const query = { table, result }
      const chain: MockQuery = ((...args: unknown[]) => {
        calls.push({ type: 'query', table, method: 'then', args })
        return chain
      }) as MockQuery
      const run = (method: string) => (...args: unknown[]): MockQuery => {
        calls.push({ type: 'query', table, method, args })
        return chain
      }
      for (const method of ['select', 'order', 'limit', 'lt', 'in', 'eq', 'insert', 'update', 'delete']) {
        chain[method] = run(method)
      }
      chain.maybeSingle = async (): Promise<MockResult> => {
        calls.push({ type: 'query', table, method: 'maybeSingle', args: [] })
        return query.result
      }
      chain.then = (resolve, reject) => Promise.resolve(query.result).then(resolve, reject)
      return chain
    },
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string, blob: Blob, options: { contentType: string; upsert: boolean }) {
            calls.push({ type: 'upload', bucket, path, blob, options })
            return uploadResult
          },
        }
      },
    },
  }
  return client
}

type SupabaseMock = ReturnType<typeof createSupabaseMock>
function backend(mock: SupabaseMock) {
  return createSupabaseBackend({ supabase: mock as unknown as Parameters<typeof createSupabaseBackend>[0]['supabase'], url: 'https://project.supabase.co' })
}
function rpcNames(mock: SupabaseMock): string[] {
  return mock.calls.filter((call) => call.type === 'rpc').map((call) => call.name ?? '')
}

test('Supabase adapter exposes all core actions in the shared API contract', async () => {
  const contract = await import('./fixtures/backend-contract.json', { with: { type: 'json' } })
  const api = backend(createSupabaseMock())
  const methods = Object.keys(api).filter((key) => typeof api[key as keyof typeof api] === 'function')
  const documented = new Set(contract.default.actions.map((action) => action.name))
  const dataMethods = new Set(methods.filter((method) => !['getSession', 'onAuthChange', 'signIn', 'signOut', 'isMember'].includes(method)))
  assert.deepEqual(dataMethods, documented)
})

test('maps all RPC and table operations to their Supabase names and payloads', async () => {
  const mock = createSupabaseMock({
    rpc: { member_access: { data: { is_member: true }, error: null }, admin_members: { data: [{ id: 'u1' }], error: null },
      get_own_profile: { data: { display_name: 'A' }, error: null }, get_profile: { data: { public_id: 'p' }, error: null },
      update_own_profile: { data: { display_name: 'B' }, error: null }, clear_avatar: { data: { avatar_url: null }, error: null },
      redeem_invite_code: { data: true, error: null } },
    tables: { cohorts: [{ data: [{ id: 1, name: 'C' }], error: null }], members: [{ data: { user_id: 'u1' }, error: null }] },
  })
  const api = backend(mock)
  assert.deepEqual(await api.memberAccess(), { is_member: true })
  assert.deepEqual(await api.adminMembers(), [{ id: 'u1' }])
  await api.adminSetDisabled('u1', true)
  await api.adminDeleteContent('p4', 'post')
  await api.adminSetRoleVerified('u1', true)
  assert.deepEqual(await api.getOwnProfile(), { display_name: 'A' })
  assert.deepEqual(await api.getProfile('p'), { public_id: 'p' })
  assert.deepEqual(await api.listCohorts(), [{ id: 1, name: 'C' }])
  assert.deepEqual(await api.updateOwnProfile({ display_name: 'B' }), { display_name: 'B' })
  assert.deepEqual(await api.clearAvatar(), { avatar_url: null })
  assert.equal(await api.isMember('u1'), true)
  assert.equal(await api.redeemInviteCode('CODE'), true)
  assert.deepEqual(rpcNames(mock), [
    'member_access', 'admin_members', 'admin_set_disabled', 'admin_delete_content', 'admin_set_role_verified',
    'get_own_profile', 'get_profile', 'update_own_profile', 'clear_avatar', 'redeem_invite_code',
  ])
  assert.deepEqual(mock.calls.find((call) => call.name === 'get_profile')?.args, { p_public_id: 'p' })
  assert.deepEqual(mock.calls.find((call) => call.name === 'admin_set_disabled')?.args, { p_user_id: 'u1', p_disabled: true })
  assert.deepEqual(mock.calls.find((call) => call.name === 'admin_delete_content')?.args, { p_id: 'p4', p_kind: 'post' })
  assert.deepEqual(mock.calls.find((call) => call.name === 'admin_set_role_verified')?.args, { p_user_id: 'u1', p_verified: true })
  assert.deepEqual(mock.calls.find((call) => call.name === 'update_own_profile')?.args, { p_profile: { display_name: 'B' } })
  assert.deepEqual(mock.calls.find((call) => call.name === 'redeem_invite_code')?.args, { p_code: 'CODE' })
  assert.deepEqual(mock.calls.filter((call) => call.table === 'cohorts').map(({ method, args }) => [method, ...(Array.isArray(args) ? args : [])]), [
    ['select', 'id,name'], ['order', 'sort_order', { ascending: true }],
  ])
})

test('avatar upload reserves a path, uploads webp, and confirms; every stage errors', async () => {
  const blob = new Blob(['webp'])
  const mock = createSupabaseMock({ rpc: { reserve_avatar_upload: { data: 'u1/avatar.webp', error: null }, confirm_avatar_upload: { data: 'confirmed', error: null } } })
  assert.equal(await backend(mock).uploadAvatar(blob), 'confirmed')
  assert.deepEqual(rpcNames(mock), ['reserve_avatar_upload', 'confirm_avatar_upload'])
  assert.deepEqual(mock.calls.find((call) => call.type === 'upload'), {
    type: 'upload', bucket: 'avatars', path: 'u1/avatar.webp', blob,
    options: { contentType: 'image/webp', upsert: false },
  })
  const reserveFailure = createSupabaseMock({ rpc: { reserve_avatar_upload: { data: null, error: new Error('reserve failed') } } })
  await assert.rejects(backend(reserveFailure).uploadAvatar(blob), /reserve failed/)
  const uploadFailure = createSupabaseMock({ rpc: { reserve_avatar_upload: { data: 'path', error: null } }, uploadResult: { data: null, error: new Error('upload failed') } })
  await assert.rejects(backend(uploadFailure).uploadAvatar(blob), /upload failed/)
  const confirmFailure = createSupabaseMock({ rpc: { reserve_avatar_upload: { data: 'path', error: null }, confirm_avatar_upload: { data: null, error: new Error('confirm failed') } } })
  await assert.rejects(backend(confirmFailure).uploadAvatar(blob), /confirm failed/)
})

test('post pages strip vote relations and derive ownership, OP, and stable reply ordering', async () => {
  const mock = createSupabaseMock({
    tables: {
      posts: [{ data: [
        { id: 9, created_at: '2026-10-02T00:00:00Z', author_name: 'P', post_votes: [{ post_id: 9 }] },
        { id: 8, created_at: '2026-10-01T00:00:00Z', author_name: 'Q', post_votes: [] },
      ], error: null }],
      replies: [{ data: [
        { id: 20, post_id: 9, parent_reply_id: null, created_at: '2026-10-02T02:00:00Z', body: 'root', reply_votes: [{ reply_id: 20 }] },
        { id: 22, post_id: 9, parent_reply_id: 21, created_at: '2026-10-02T04:00:00Z', body: 'child', reply_votes: [] },
        { id: 21, post_id: 9, parent_reply_id: 20, created_at: '2026-10-02T03:00:00Z', body: 'reply', reply_votes: [] },
      ], error: null }],
    },
    rpc: {
      own_content_ids: { data: { posts: [9], replies: [20] }, error: null },
      op_reply_ids: { data: [20, 21], error: null },
    },
  })
  const [post] = await backend(mock).listPosts({ before: '2026-10-03T00:00:00Z' })
  assert.equal(post.liked_by_me, true)
  assert.equal(post.is_mine, true)
  assert.equal('post_votes' in post, false)
  assert.deepEqual(post.replies.map((reply) => reply.id), [20, 21, 22])
  assert.deepEqual(post.replies.map((reply) => reply.liked_by_me), [true, false, false])
  assert.deepEqual(post.replies.map((reply) => reply.is_op), [true, true, false])
  assert.equal(post.replies[0].is_mine, true)
  assert.equal('reply_votes' in post.replies[0], false)
  assert.ok(mock.calls.some((call) => call.table === 'posts' && call.method === 'lt' && Array.isArray(call.args) && call.args[0] === 'created_at'))
})

test('search hydrates full matching threads and my content retains its scoped RPC shape', async () => {
  const mine = { posts: [{ id: 9, title: 'Own anonymous post', is_anonymous: true }], replies: [{ id: 20, post_id: 9, body: 'Own reply', post_title: 'Thread' }] }
  const mock = createSupabaseMock({
    rpc: {
      search_posts: { data: [9], error: null },
      own_content_ids: { data: { posts: [9], replies: [20] }, error: null },
      op_reply_ids: { data: [20], error: null },
      my_content: { data: mine, error: null },
    },
    tables: {
      posts: [{ data: [{ id: 9, title: '工作', post_votes: [{ post_id: 9 }] }], error: null }],
      replies: [{ data: [{ id: 20, post_id: 9, body: 'Reply', reply_votes: [] }], error: null }],
    },
  })
  const api = backend(mock)
  const [post] = await api.searchPosts('工作 %_.*')
  assert.equal(post.is_mine, true)
  assert.equal(post.liked_by_me, true)
  assert.equal(post.replies[0].is_mine, true)
  assert.equal(post.replies[0].is_op, true)
  assert.equal('post_votes' in post, false)
  assert.equal('reply_votes' in post.replies[0], false)
  assert.deepEqual(mock.calls.find(({ name }) => name === 'search_posts')?.args, { p_query: '工作 %_.*' })
  assert.ok(mock.calls.some(({ table, method, args }) => table === 'posts' && method === 'in' && Array.isArray(args) && args[0] === 'id' && Array.isArray(args[1]) && args[1][0] === 9))
  assert.deepEqual(await api.listMine(), mine)
})

test('empty and failed search/my-content RPCs preserve expected empty results and errors', async () => {
  const empty = createSupabaseMock()
  assert.deepEqual(await backend(empty).searchPosts(''), [])
  assert.equal(empty.calls.some(({ type }) => type === 'query'), false)
  assert.deepEqual(await backend(empty).listMine(), { posts: [], replies: [] })
  const failed = createSupabaseMock({ rpc: {
    search_posts: { data: null, error: new Error('search failed') },
    my_content: { data: null, error: new Error('my content failed') },
  } })
  await assert.rejects(backend(failed).searchPosts('query'), /search failed/)
  await assert.rejects(backend(failed).listMine(), /my content failed/)
})

test('liked content joins titles and sorts both result sets newest first', async () => {
  const mock = createSupabaseMock({ tables: {
    post_votes: [{ data: [
      { posts: { id: 1, title: 'old', created_at: '2026-01-01' } },
      { posts: { id: 2, title: 'new', created_at: '2026-02-01' } },
      { posts: null },
    ], error: null }],
    reply_votes: [{ data: [
      { replies: { id: 3, body: 'old', created_at: '2026-01-01', posts: { title: 'Thread' } } },
      { replies: { id: 4, body: 'new', created_at: '2026-02-01', posts: { title: 'Thread' } } },
    ], error: null }],
  } })
  const result = await backend(mock).listLiked()
  assert.deepEqual(result.posts.map((post) => post.id), [2, 1])
  assert.deepEqual(result.replies.map((reply) => reply.id), [4, 3])
  assert.equal(result.replies[0].post_title, 'Thread')
  assert.equal('posts' in result.replies[0], false)
})

test('writes content through expected Supabase tables/RPCs and reports missing rows', async () => {
  const mock = createSupabaseMock({
    rpc: {
      delete_own_post: { data: null, error: null }, toggle_reply_vote: { data: null, error: null }, toggle_post_vote: { data: null, error: null },
    },
    tables: {
      posts: [{ data: null, error: null }, { data: [{ id: 5 }], error: null }, { data: [], error: null }],
      replies: [{ data: null, error: null }, { data: [{ id: 6 }], error: null }, { data: [], error: null }, { data: [{ id: 6 }], error: null }, { data: [], error: null }],
      feedback: [{ data: null, error: null }],
    },
  })
  const api = backend(mock)
  await api.createPost({ title: 'title', body: 'body', is_anonymous: true })
  await api.updatePost(5, { title: 'edited', body: 'edited body' })
  await assert.rejects(api.updatePost(99, { title: 'missing', body: 'missing body' }), /已经不存在/)
  await api.deletePost(5)
  await api.createReply(5, { body: 'reply', is_anonymous: true })
  await api.updateReply(6, 'edited')
  await assert.rejects(api.updateReply(99, 'missing'), /已经不存在/)
  await api.deleteReply(6)
  await assert.rejects(api.deleteReply(99), /已经不存在/)
  await api.createFeedback({ body: 'feedback' })
  await api.toggleReplyVote(6)
  await api.togglePostVote(5)
  assert.deepEqual(rpcNames(mock), ['delete_own_post', 'toggle_reply_vote', 'toggle_post_vote'])
  assert.deepEqual(mock.calls.find((call) => call.table === 'posts' && call.method === 'insert')?.args, [{ title: 'title', body: 'body', is_anonymous: true }])
  assert.deepEqual(mock.calls.find((call) => call.table === 'replies' && call.method === 'insert')?.args, [{ post_id: 5, body: 'reply', is_anonymous: true }])
})

test('propagates errors from ordinary RPC and query calls', async () => {
  const rpcError = createSupabaseMock({ rpc: { member_access: { data: null, error: new Error('rpc broke') } } })
  await assert.rejects(backend(rpcError).memberAccess(), /rpc broke/)
  const queryError = createSupabaseMock({ tables: { cohorts: [{ data: null, error: new Error('query broke') }] } })
  await assert.rejects(backend(queryError).listCohorts(), /query broke/)
})
