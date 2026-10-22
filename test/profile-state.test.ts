import test from 'node:test'
import assert from 'node:assert/strict'
import type { OwnProfile } from '../src/types.ts'
import {
  cancelProfileEdit,
  captureProfileDraft,
  createProfileViewState,
  enterProfilePreview,
  exitProfilePreview,
  profileForPresentation,
  profileTabVisibility,
  selectProfileTab,
  startProfileEdit,
  visibleProfileContacts,
} from '../src/profile-state.ts'

const savedProfile = {
  public_id: 'lin-ran',
  display_name: 'Lin Ran',
  tagline: null,
  avatar_url: '',
  role: 'mentor' as const,
  cohort_id: null,
  cohort_name: null,
  graduation_year: null,
  role_verified: false,
  is_self: true,
  bio: 'Saved introduction',
  linkedin_url: 'https://www.linkedin.com/in/linran',
  linkedin_public: true,
  contact_email: 'linran@example.com',
  email_public: true,
  wechat_id: 'linran_work',
  wechat_public: false,
} satisfies OwnProfile

test('member preview shows the current draft and returning to edit retains it', () => {
  const draft = { display_name: 'Draft name', tagline: '', bio: 'Unsaved introduction' }
  let state = startProfileEdit(createProfileViewState())
  state = enterProfilePreview(state, draft)

  assert.equal(profileForPresentation(savedProfile, state).display_name, 'Draft name')
  assert.equal(profileForPresentation(savedProfile, state).bio, 'Unsaved introduction')

  state = exitProfilePreview(state)
  assert.equal(state.editing, true)
  assert.equal(state.draft?.display_name, 'Draft name')
  assert.equal(profileForPresentation(savedProfile, state).display_name, 'Draft name')
})

test('cancel discards the draft and presentation returns to saved values', () => {
  let state = startProfileEdit(createProfileViewState())
  state = captureProfileDraft(state, { display_name: 'Unsaved name' })
  state = cancelProfileEdit(state)

  assert.equal(state.draft, null)
  assert.equal(state.editing, false)
  assert.equal(profileForPresentation(savedProfile, state).display_name, 'Lin Ran')
})

test('member presentation filters private contact rows while owner view keeps them', () => {
  assert.deepEqual(visibleProfileContacts(savedProfile).map(({ key }) => key), [
    'linkedin_url', 'contact_email',
  ])
  assert.deepEqual(visibleProfileContacts(savedProfile, true).map(({ key }) => key), [
    'linkedin_url', 'contact_email', 'wechat_id',
  ])
})

test('discussion tab is local and preview returns to the profile tab', () => {
  let state = selectProfileTab(createProfileViewState(), 'discussions')
  assert.deepEqual(profileTabVisibility(state), {
    showProfile: false,
    showDiscussions: true,
    showTabs: true,
  })

  state = enterProfilePreview(state)
  assert.deepEqual(profileTabVisibility(state), {
    showProfile: false,
    showDiscussions: false,
    showTabs: false,
  })
  state = exitProfilePreview(state)
  assert.equal(state.activeTab, 'profile')
  assert.equal(profileTabVisibility(state).showProfile, true)
})
