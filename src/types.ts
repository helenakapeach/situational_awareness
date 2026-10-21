export interface SessionUser {
  id: string
  email?: string | null
  user_metadata?: { full_name?: string; name?: string; avatar_url?: string }
}

export interface AppSession {
  access_token?: string
  app_access_token?: string
  user: SessionUser
}

export interface Reply {
  id: number | string
  post_id: number | string
  parent_reply_id?: number | string | null
  author_id?: string | null
  author_name: string
  author_avatar_url: string
  author_public_id?: string | null
  author_role?: string | null
  author_cohort_name?: string | null
  author_role_verified?: boolean
  is_anonymous: boolean
  is_mine?: boolean
  is_op?: boolean
  body: string
  created_at: string
  updated_at?: string | null
  upvote_count: number
  liked_by_me: boolean
  post_title?: string
}

export interface PostSummary {
  id: number | string
  title: string
  created_at: string
  is_anonymous: boolean
  author_name: string
}

export interface ReplySummary {
  id: number | string
  post_id: number | string
  body: string
  created_at: string
  is_anonymous: boolean
  author_name: string
  post_title: string
}

export interface Post {
  id: number | string
  title: string
  body: string
  author_id?: string | null
  author_name: string
  author_avatar_url: string
  author_public_id?: string | null
  author_role?: string | null
  author_cohort_name?: string | null
  author_role_verified?: boolean
  is_anonymous: boolean
  is_mine?: boolean
  created_at: string
  updated_at?: string | null
  upvote_count: number
  liked_by_me: boolean
  replies: Reply[]
}

export interface Profile {
  public_id?: string
  display_name: string
  tagline?: string | null
  bio?: string | null
  avatar_url?: string | null
  linkedin_url?: string | null
  linkedin_public?: boolean
  contact_email?: string | null
  email_public?: boolean
  wechat_id?: string | null
  wechat_public?: boolean
  role?: string | null
  cohort_id?: number | string | null
  cohort_name?: string | null
  graduation_year?: number | string | null
  role_verified?: boolean
  [key: string]: unknown
}

export type ProfileCard = Pick<Profile, 'display_name'> & Partial<Omit<Profile, 'display_name'>> & { is_self?: boolean }

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

export interface Cohort {
  id: number
  name: string
}

export interface Member {
  id: string
  user_id?: string
  name?: string
  role?: string | null
  cohort_name?: string | null
  is_admin?: boolean
  email?: string | null
  display_name?: string
  is_disabled?: boolean
  role_verified?: boolean
  [key: string]: unknown
}

export interface Backend {
  mode: 'demo' | 'mongo' | 'supabase'
  isDemo: boolean
  storageBase: string
  getSession(): Promise<AppSession | null>
  onAuthChange(callback: (session: AppSession | null) => void): () => void
  signIn(): Promise<void>
  signOut(): Promise<void>
  memberAccess(): Promise<{ is_member: boolean; is_admin: boolean; is_disabled: boolean }>
  adminMembers(): Promise<Member[]>
  adminSetDisabled(userId: string, disabled: boolean): Promise<void>
  adminDeleteContent(contentId: string | number, kind: 'post' | 'reply'): Promise<void>
  adminSetRoleVerified(userId: string, verified: boolean): Promise<void>
  getOwnProfile(): Promise<Profile | null>
  getProfile(publicId: string): Promise<ProfileCard | null>
  listCohorts(): Promise<Cohort[]>
  updateOwnProfile(profile: Partial<Profile>): Promise<Profile>
  uploadAvatar(blob: Blob): Promise<Profile>
  clearAvatar(): Promise<Profile>
  isMember(userId?: string): Promise<boolean>
  redeemInviteCode(code: string): Promise<boolean>
  listPosts(options?: { before?: string | null; before_id?: number | string | null }): Promise<Post[]>
  searchPosts(term: string): Promise<Post[]>
  listMine(): Promise<{ posts: PostSummary[]; replies: ReplySummary[] }>
  createPost(post: Pick<Post, 'title' | 'body' | 'is_anonymous'>): Promise<void>
  updatePost(postId: string | number, post: Pick<Post, 'title' | 'body'>): Promise<void>
  deletePost(postId: string | number): Promise<void>
  createReply(postId: string | number, reply: Pick<Reply, 'body' | 'is_anonymous'> & { parent_reply_id?: string | number | null }): Promise<void>
  updateReply(replyId: string | number, body: string): Promise<void>
  deleteReply(replyId: string | number): Promise<void>
  togglePostVote(postId: string | number): Promise<void>
  toggleReplyVote(replyId: string | number): Promise<void>
  listLiked(): Promise<{ posts: PostSummary[]; replies: ReplySummary[] }>
  createFeedback(feedback: { body: string }): Promise<void>
}
