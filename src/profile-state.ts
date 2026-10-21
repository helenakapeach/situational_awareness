import type { Profile } from './types.ts'

export type ProfileDraft = Partial<Omit<Profile, 'cohort_id' | 'graduation_year'>> & { cohort_id?: number | string | null; graduation_year?: number | string | null }

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

export function profileForPresentation(savedProfile: Profile, state: ProfileViewState): Profile {
  return state.editing && state.draft
    ? { ...savedProfile, ...state.draft }
    : savedProfile
}

export function visibleProfileContacts(profile: Partial<Profile>, includePrivate = false) {
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
