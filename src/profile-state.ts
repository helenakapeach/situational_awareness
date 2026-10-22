import type { OwnProfile, ProfileFormInput, ProfileForDisplay } from './types.ts'

export type ProfileDraft = Partial<ProfileFormInput>

export interface ProfileViewState {
  editing: boolean
  previewing: boolean
  draft: ProfileDraft | null
  activeTab: 'profile' | 'discussions'
}

export function createProfileViewState(): ProfileViewState {
  return { editing: false, previewing: false, draft: null, activeTab: 'profile' }
}

export function startProfileEdit(state: ProfileViewState): ProfileViewState {
  return { ...state, editing: true, previewing: false, draft: null, activeTab: 'profile' }
}

export function captureProfileDraft(state: ProfileViewState, draft: ProfileDraft): ProfileViewState {
  return { ...state, draft: { ...draft } }
}

export function enterProfilePreview(state: ProfileViewState, draft: ProfileDraft | null = state.draft): ProfileViewState {
  return {
    ...state,
    draft: state.editing && draft ? { ...draft } : state.draft,
    previewing: true,
    activeTab: 'profile',
  }
}

export function exitProfilePreview(state: ProfileViewState): ProfileViewState {
  return { ...state, previewing: false }
}

export function cancelProfileEdit(_state: ProfileViewState): ProfileViewState {
  return { editing: false, previewing: false, draft: null, activeTab: 'profile' }
}

export function selectProfileTab(state: ProfileViewState, tab: string, draft: ProfileDraft | null = state.draft): ProfileViewState {
  return {
    ...state,
    draft: state.editing && draft ? { ...draft } : state.draft,
    previewing: false,
    activeTab: tab === 'discussions' ? 'discussions' : 'profile',
  }
}

export function profileForPresentation(savedProfile: OwnProfile, state: ProfileViewState): ProfileForDisplay {
  return state.editing && state.draft
    ? { ...savedProfile, ...state.draft }
    : savedProfile
}

type ContactProfile = Pick<OwnProfile, 'linkedin_url' | 'linkedin_public' | 'contact_email' | 'email_public' | 'wechat_id' | 'wechat_public'>

export function visibleProfileContacts(profile: Partial<ContactProfile>, includePrivate = false) {
  return [
    { key: 'linkedin_url', icon: 'linkedin', label: 'LinkedIn', value: profile.linkedin_url, isPublic: profile.linkedin_public },
    { key: 'contact_email', icon: 'mail', label: '联系邮箱', value: profile.contact_email, isPublic: profile.email_public },
    { key: 'wechat_id', icon: 'wechat', label: '微信号', value: profile.wechat_id, isPublic: profile.wechat_public },
  ].filter((contact) => contact.value && (includePrivate || contact.isPublic))
}

export function profileTabVisibility(state: ProfileViewState) {
  return {
    showProfile: !state.previewing && state.activeTab === 'profile',
    showDiscussions: !state.previewing && state.activeTab === 'discussions',
    showTabs: !state.previewing,
  }
}
