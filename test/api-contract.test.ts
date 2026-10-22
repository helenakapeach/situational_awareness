import test from 'node:test'
import assert from 'node:assert/strict'
import { createHttpBackend } from '../src/http-backend.ts'
import type { HttpMember, HttpOwnProfile, HttpPublicProfileCard, MineContent, ProfileUpdateRequest } from '../src/types.ts'

const mine = {
  posts: [{ id: 31, title: 'A post', created_at: '2026-10-21T12:00:00Z', is_anonymous: false }],
  replies: [{ id: 45, post_id: 31, body: 'A reply', created_at: '2026-10-21T12:01:00Z', is_anonymous: true, post_title: 'A post' }],
} satisfies MineContent

const adminMember = {
  user_id: 'member-1',
  name: null,
  display_name: 'Member One',
  role: null,
  cohort_name: null,
  email: 'member@example.test',
  joined_at: null,
  is_disabled: false,
  is_admin: false,
  role_verified: false,
} satisfies HttpMember

const ownProfile = {
  public_id: 'member-1',
  display_name: 'Member One',
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
  is_self: true,
} satisfies HttpOwnProfile

const publicCard = {
  public_id: 'member-1',
  display_name: 'Member One',
  tagline: null,
  bio: null,
  avatar_url: '',
  role: null,
  cohort_name: null,
  graduation_year: null,
  role_verified: false,
  is_self: false,
} satisfies HttpPublicProfileCard

const profileUpdate = {
  display_name: 'Updated name',
  role: 'mentor',
  cohort_id: null,
  graduation_year: null,
  linkedin_url: null,
} satisfies ProfileUpdateRequest

test('HTTP endpoint fixtures keep Python response and request contracts distinct', () => {
  assert.equal('author_name' in mine.posts[0]!, false)
  assert.equal('author_name' in mine.replies[0]!, false)
  assert.equal('id' in adminMember, false)
  assert.equal(adminMember.user_id, 'member-1')
  assert.equal('cohort_id' in publicCard, false)
  assert.equal('linkedin_public' in publicCard, false)
  assert.equal('public_id' in profileUpdate, false)
  assert.equal('avatar_url' in profileUpdate, false)
  assert.equal('is_self' in ownProfile, true)
})

test('HTTP adapter passes endpoint DTOs through with their Python response shapes', async () => {
  const calls: string[] = []
  const session = { access_token: 'supabase', user: { id: 'member-1' } }
  const auth = {
    async getSession() { return { data: { session }, error: null } },
    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } } },
    async signInWithOAuth() { return { error: null } },
    async signOut() { return { error: null } },
  }
  const backend = createHttpBackend({
    baseUrl: 'http://api.test',
    auth,
    fetchImpl: async (url) => {
      if (url.endsWith('/api/auth/session')) {
        return new Response(JSON.stringify({
          accessToken: 'api-token', tokenType: 'Bearer', expiresIn: 600,
          user: { id: 'member-1', email: 'member@example.test', user_metadata: {} },
        }))
      }
      calls.push(url)
      if (url.endsWith('/api/me/content')) return new Response(JSON.stringify(mine))
      if (url.endsWith('/api/admin/members')) return new Response(JSON.stringify([adminMember]))
      if (url.endsWith('/api/profiles/member-1')) return new Response(JSON.stringify(publicCard))
      return new Response(JSON.stringify(ownProfile))
    },
  })

  assert.deepEqual(await backend.listMine(), mine)
  assert.deepEqual(await backend.adminMembers(), [adminMember])
  assert.deepEqual(await backend.getProfile('member-1'), publicCard)
  assert.deepEqual(await backend.getOwnProfile(), ownProfile)
  assert.deepEqual(await backend.updateOwnProfile(profileUpdate), ownProfile)
  assert.equal(calls.filter((url) => url.endsWith('/api/profile')).length, 2)
  assert.equal('author_name' in (await backend.listMine()).posts[0]!, false)
})

test('profile update requests reject response-only fields at compile time', () => {
  function acceptProfileUpdate(_value: ProfileUpdateRequest) {}
  // @ts-expect-error public_id is only returned by profile endpoints
  acceptProfileUpdate({ display_name: 'Updated name', public_id: 'member-1' })
})
