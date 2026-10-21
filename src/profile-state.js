export function createProfileViewState() {
  return { editing: false, previewing: false, draft: null, activeTab: 'profile' }
}

export function startProfileEdit(state) {
  return { ...state, editing: true, previewing: false, draft: null, activeTab: 'profile' }
}

export function captureProfileDraft(state, draft) {
  return { ...state, draft: { ...draft } }
}

export function enterProfilePreview(state, draft = state.draft) {
  return {
    ...state,
    draft: state.editing && draft ? { ...draft } : state.draft,
    previewing: true,
    activeTab: 'profile',
  }
}

export function exitProfilePreview(state) {
  return { ...state, previewing: false }
}

export function cancelProfileEdit(state) {
  return { editing: false, previewing: false, draft: null, activeTab: 'profile' }
}

export function selectProfileTab(state, tab, draft = state.draft) {
  return {
    ...state,
    draft: state.editing && draft ? { ...draft } : state.draft,
    previewing: false,
    activeTab: tab === 'discussions' ? 'discussions' : 'profile',
  }
}

export function profileForPresentation(savedProfile, state) {
  return state.editing && state.draft
    ? { ...savedProfile, ...state.draft }
    : savedProfile
}

export function visibleProfileContacts(profile, includePrivate = false) {
  return [
    { key: 'linkedin_url', icon: 'linkedin', label: 'LinkedIn', value: profile.linkedin_url, isPublic: profile.linkedin_public },
    { key: 'contact_email', icon: 'mail', label: '联系邮箱', value: profile.contact_email, isPublic: profile.email_public },
    { key: 'wechat_id', icon: 'wechat', label: '微信号', value: profile.wechat_id, isPublic: profile.wechat_public },
  ].filter((contact) => contact.value && (includePrivate || contact.isPublic))
}

export function profileTabVisibility(state) {
  return {
    showProfile: !state.previewing && state.activeTab === 'profile',
    showDiscussions: !state.previewing && state.activeTab === 'discussions',
    showTabs: !state.previewing,
  }
}
