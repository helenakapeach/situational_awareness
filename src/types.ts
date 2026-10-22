export type MemberRole = 'committee' | 'mentor' | 'student' | 'other'

export interface SessionUser {
  id: string
  email?: string | null
  user_metadata?: { full_name?: string; name?: string; avatar_url?: string }
}

export interface AppSession {
  access_token?: string
  app_access_token?: string
  app_token_type?: string
  user: SessionUser
}

export interface Reply {
  id: number | string
  post_id: number | string
  parent_reply_id?: number | string | null
  author_name: string
  author_avatar_url: string
  author_public_id?: string | null
  author_role?: string | null
  author_cohort_name?: string | null
  author_role_verified?: boolean
  is_anonymous: boolean
  is_mine: boolean
  is_op: boolean
  body: string
  created_at: string
  updated_at?: string | null
  upvote_count: number
  liked_by_me: boolean
  post_title?: string
}

export interface Post {
  id: number | string
  title: string
  body: string
  author_name: string
  author_avatar_url: string
  author_public_id?: string | null
  author_role?: string | null
  author_cohort_name?: string | null
  author_role_verified?: boolean
  is_anonymous: boolean
  is_mine: boolean
  created_at: string
  updated_at?: string | null
  upvote_count: number
  liked_by_me: boolean
  replies: Reply[]
}

export interface HttpReply extends Omit<Reply, 'id' | 'post_id' | 'parent_reply_id'> {
  id: number
  post_id: number
  parent_reply_id?: number | null
  author_public_id: string | null
  author_role: string | null
  author_cohort_name: string | null
  author_role_verified: boolean
}

export interface HttpPost extends Omit<Post, 'id' | 'replies'> {
  id: number
  replies: HttpReply[]
  author_public_id: string | null
  author_role: string | null
  author_cohort_name: string | null
  author_role_verified: boolean
}

export interface MinePost {
  id: number | string
  title: string
  created_at: string
  is_anonymous: boolean
}

export interface MineReply {
  id: number | string
  post_id: number | string
  body: string
  created_at: string
  is_anonymous: boolean
  post_title: string
}

export interface LikedPost extends MinePost {
  author_name: string
}

export interface LikedReply extends MineReply {
  author_name: string
}

export interface MineContent {
  posts: MinePost[]
  replies: MineReply[]
}

export interface LikedContent {
  posts: LikedPost[]
  replies: LikedReply[]
}

export interface HttpMinePost extends Omit<MinePost, 'id'> {
  id: number
}

export interface HttpMineReply extends Omit<MineReply, 'id' | 'post_id'> {
  id: number
  post_id: number
}

export interface HttpLikedPost extends HttpMinePost {
  author_name: string
}

export interface HttpLikedReply extends HttpMineReply {
  author_name: string
}

export interface HttpMineContent {
  posts: HttpMinePost[]
  replies: HttpMineReply[]
}

export interface HttpLikedContent {
  posts: HttpLikedPost[]
  replies: HttpLikedReply[]
}

export interface OwnProfile {
  public_id: string
  display_name: string
  tagline: string | null
  bio: string | null
  avatar_url: string | null
  linkedin_url: string | null
  linkedin_public: boolean
  contact_email: string | null
  email_public: boolean
  wechat_id: string | null
  wechat_public: boolean
  role: MemberRole | null
  cohort_id: number | null
  cohort_name: string | null
  graduation_year: number | null
  role_verified: boolean
  is_self: boolean
}

/** FastAPI normalizes Supabase's nullable avatar_url to an empty string. */
export interface HttpOwnProfile extends Omit<OwnProfile, 'avatar_url'> {
  avatar_url: string
}

export type Profile = OwnProfile

export interface HttpPublicProfileCard {
  public_id: string
  display_name: string
  tagline: string | null
  bio: string | null
  avatar_url: string
  role: MemberRole | null
  cohort_name: string | null
  graduation_year: number | null
  role_verified: boolean
  is_self: boolean
  linkedin_url?: string
  contact_email?: string
  wechat_id?: string
}

export interface SupabasePublicProfileCard extends Omit<HttpPublicProfileCard, 'avatar_url'> {
  avatar_url: string | null
  cohort_id: null
}

export interface DemoProfileCard {
  public_id: string
  display_name: string
  tagline?: string | null
  bio?: string | null
  avatar_url?: string | null
  role?: MemberRole | null
  cohort_name?: string | null
  graduation_year?: number | null
  role_verified?: boolean
  is_self?: boolean
  linkedin_url?: string
  contact_email?: string
  wechat_id?: string
}

export type ProfileCard = HttpPublicProfileCard | SupabasePublicProfileCard | DemoProfileCard

export type ProfileForDisplay = Omit<OwnProfile, 'role' | 'cohort_id' | 'graduation_year'> & {
  role: string | null
  cohort_id: number | string | null
  graduation_year: number | string | null
}

export interface ProfileUpdateRequest {
  display_name: string
  tagline?: string | null
  bio?: string | null
  linkedin_url?: string | null
  linkedin_public?: boolean
  contact_email?: string | null
  email_public?: boolean
  wechat_id?: string | null
  wechat_public?: boolean
  role?: MemberRole | null
  cohort_id?: number | null
  graduation_year?: number | null
}

export interface ProfileFormInput {
  display_name: string
  tagline: string
  bio: string
  linkedin_url: string
  linkedin_public: boolean
  contact_email: string
  email_public: boolean
  wechat_id: string
  wechat_public: boolean
  role: string
  cohort_id: string
  graduation_year: string
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

export interface Cohort {
  id: number
  name: string
}

export interface Member {
  user_id: string
  name: string | null
  display_name: string | null
  role: string | null
  cohort_name: string | null
  email: string | null
  joined_at: string | null
  is_disabled: boolean
  is_admin: boolean
  role_verified: boolean
}

export interface HttpMember extends Omit<Member, 'email'> {
  email: string
}

export interface BackendBase {
  mode: 'demo' | 'mongo' | 'supabase'
  storageBase: string
  getSession(): Promise<AppSession | null>
  onAuthChange(callback: (session: AppSession | null) => void): () => void
  signIn(): Promise<void>
  signOut(): Promise<void>
  memberAccess(): Promise<{ is_member: boolean; is_admin: boolean; is_disabled: boolean }>
  getOwnProfile(): Promise<OwnProfile | null>
  getProfile(publicId: string): Promise<ProfileCard | null>
  listCohorts(): Promise<Cohort[]>
  updateOwnProfile(profile: ProfileUpdateRequest): Promise<OwnProfile>
  uploadAvatar(blob: Blob): Promise<OwnProfile>
  clearAvatar(): Promise<OwnProfile>
  isMember(userId?: string): Promise<boolean>
  redeemInviteCode(code: string): Promise<boolean>
  listPosts(options?: { before?: string | null; before_id?: number | string | null }): Promise<Post[]>
  searchPosts(term: string): Promise<Post[]>
  listMine(): Promise<MineContent>
  createPost(post: Pick<Post, 'title' | 'body' | 'is_anonymous'>): Promise<void>
  updatePost(postId: string | number, post: Pick<Post, 'title' | 'body'>): Promise<void>
  deletePost(postId: string | number): Promise<void>
  createReply(postId: string | number, reply: Pick<Reply, 'body' | 'is_anonymous'> & { parent_reply_id?: string | number | null }): Promise<void>
  updateReply(replyId: string | number, body: string): Promise<void>
  deleteReply(replyId: string | number): Promise<void>
  togglePostVote(postId: string | number): Promise<void>
  toggleReplyVote(replyId: string | number): Promise<void>
  listLiked(): Promise<LikedContent>
  createFeedback(feedback: { body: string }): Promise<void>
}

export interface AdminBackend extends BackendBase {
  isDemo: false
  adminMembers(): Promise<Member[]>
  adminSetDisabled(userId: string, disabled: boolean): Promise<void>
  adminDeleteContent(contentId: string | number, kind: 'post' | 'reply'): Promise<void>
  adminSetRoleVerified(userId: string, verified: boolean): Promise<void>
}

export interface DemoBackend extends BackendBase {
  isDemo: true
}

export type Backend = AdminBackend | DemoBackend

export interface HttpBackend extends AdminBackend {
  getPost(postId: string | number): Promise<HttpPost>
  listPosts(options?: { before?: string | null; before_id?: number | string | null }): Promise<HttpPost[]>
  searchPosts(term: string): Promise<HttpPost[]>
  listMine(): Promise<HttpMineContent>
  listLiked(): Promise<HttpLikedContent>
}
