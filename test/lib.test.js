import assert from 'node:assert/strict'
import test from 'node:test'

import {
  anonymousPersona,
  assignAnonymousPersonas,
  backendStorageKey,
  displayAvatarUrl,
  displayName,
  excerptPlain,
  formatAbsoluteTime,
  formatRelativeTime,
  isNewReply,
  replyIsFromOp,
  groupReplyThreads,
  initials,
  isLateNight,
  isUploadedAvatar,
  reachedMilestones,
  normalizeInviteCode,
  normalizeLinkedInUrl,
  normalizePostId,
  postIdFromSearch,
  postShareText,
  postUrl,
  roleLabel,
  safeAvatarUrl,
  sortReplies,
  unreadReplyCount,
  validateFeedback,
  validateInviteCode,
  validatePost,
  validateProfile,
  validateReply,
  validLinkedInUrl,
  withVoteState,
} from '../src/lib.js'
import { renderMarkdown, safeHref } from '../src/markdown.js'

test('post validation trims valid content and rejects missing fields', () => {
  assert.deepEqual(validatePost('  一个问题  ', '  一些背景  '), {
    ok: true,
    value: { title: '一个问题', body: '一些背景' },
  })
  assert.equal(validatePost('短', '有背景').ok, false)
  assert.equal(validatePost('有效标题', '   ').ok, false)
})

test('reply validation rejects empty and oversized replies', () => {
  assert.deepEqual(validateReply('  一个建议  '), {
    ok: true,
    value: { body: '一个建议', is_anonymous: false },
  })
  assert.deepEqual(validateReply('一个建议', true), {
    ok: true,
    value: { body: '一个建议', is_anonymous: true },
  })
  assert.equal(validateReply(' ').ok, false)
  assert.equal(validateReply('a'.repeat(2001)).ok, false)
})

test('feedback validation trims text and rejects empty or oversized notes', () => {
  assert.deepEqual(validateFeedback('  登录按钮有点慢  '), {
    ok: true,
    value: { body: '登录按钮有点慢' },
  })
  assert.equal(validateFeedback(' ').ok, false)
  assert.equal(validateFeedback('a'.repeat(2001)).ok, false)
})

test('relative time handles recent, hourly, daily and invalid dates', () => {
  const now = Date.parse('2026-09-13T12:00:00Z')
  assert.equal(formatRelativeTime('2026-09-13T11:59:40Z', now), '刚刚')
  assert.equal(formatRelativeTime('2026-09-13T11:20:00Z', now), '40 分钟前')
  assert.equal(formatRelativeTime('2026-09-13T08:00:00Z', now), '4 小时前')
  assert.equal(formatRelativeTime('2026-09-11T12:00:00Z', now), '2 天前')
  assert.equal(formatRelativeTime('not-a-date', now), '刚刚')
})

test('profile validation accepts a complete card and rejects bad contact details', () => {
  assert.deepEqual(validateProfile({
    display_name: '  林然  ',
    tagline: '  把选择权交回去  ',
    bio: '第一段\n第二段',
    linkedin_url: 'https://www.linkedin.com/in/example-lin',
    linkedin_public: true,
    contact_email: ' Lin@Example.com ',
    email_public: false,
    wechat_id: '',
    wechat_public: true,
    role: 'student',
    cohort_id: '2',
  }), {
    ok: true,
    value: {
      display_name: '林然',
      tagline: '把选择权交回去',
      bio: '第一段\n第二段',
      linkedin_url: 'https://www.linkedin.com/in/example-lin',
      linkedin_public: true,
      contact_email: 'lin@example.com',
      email_public: false,
      wechat_id: null,
      wechat_public: false,
      role: 'student',
      cohort_id: 2,
      graduation_year: null,
    },
  })
  assert.equal(validateProfile({ display_name: '好', role: 'student', graduation_year: 2015 }).ok, false)
  assert.equal(validateProfile({ display_name: '好', role: 'student', graduation_year: 2028 }).ok, false)
  assert.equal(validateProfile({ display_name: '好', role: 'student', graduation_year: 2016 }).value.graduation_year, 2016)
  assert.equal(validateProfile({ display_name: '好', role: 'committee', graduation_year: 2016, cohort_id: 1 }).value.graduation_year, null)
  assert.equal(validateProfile({ display_name: '好', role: 'mentor', graduation_year: 2020 }).value.graduation_year, null)
  assert.equal(validateProfile({ display_name: '好', role: 'committee', cohort_id: 1 }).value.cohort_id, null)
  assert.equal(validateProfile({ display_name: '' }).ok, false)
  assert.equal(validateProfile({ display_name: '好', linkedin_url: 'https://evil.example/in/lin' }).ok, false)
  assert.equal(validateProfile({ display_name: '好', linkedin_url: 'www.evil.example/in/lin' }).ok, false)
  assert.equal(
    validateProfile({ display_name: '好', linkedin_url: ' www.linkedin.com/in/example-lin ' }).value.linkedin_url,
    'https://www.linkedin.com/in/example-lin',
  )
  assert.equal(
    validateProfile({ display_name: '好', linkedin_url: 'http://linkedin.com/in/example-lin' }).value.linkedin_url,
    'https://linkedin.com/in/example-lin',
  )
  assert.equal(validateProfile({ display_name: '好', contact_email: 'not-an-email' }).ok, false)
  assert.equal(validateProfile({ display_name: '好', wechat_id: '12bad' }).ok, false)
  assert.equal(validateProfile({ display_name: '好', role: 'staff' }).ok, false)
  assert.equal(validateProfile({ display_name: '好', role: 'mentor', cohort_id: 4 }).value.cohort_id, null)
})

test('LinkedIn display input becomes a usable URL in unsaved profile previews', () => {
  const previewUrl = normalizeLinkedInUrl('www.linkedin.com/in/linran')
  assert.equal(previewUrl, 'https://www.linkedin.com/in/linran')
  assert.equal(validLinkedInUrl(previewUrl), true)
})

test('anonymous personas stay on the content and not the person', () => {
  const first = anonymousPersona('post-2')
  assert.deepEqual(anonymousPersona('post-2'), first)
  assert.notEqual(anonymousPersona('reply-1').name, anonymousPersona('user-secret').name)
  const seen = new Set()
  for (let id = 1; id <= 32; id += 1) {
    const persona = anonymousPersona(id)
    assert.match(persona.name, /^小/)
    assert.ok(persona.emoji)
    seen.add(persona.name)
  }
  assert.ok(seen.size >= 10)
})

test('one thread never gives two anonymous people the same animal', () => {
  const ids = Array.from({ length: 16 }, (_, index) => `reply-${index + 1}`)
  const assigned = assignAnonymousPersonas(ids)
  assert.equal(new Set([...assigned.values()].map((persona) => persona.name)).size, 16)
  assert.deepEqual(assignAnonymousPersonas(ids), assigned)
  assert.equal(assignAnonymousPersonas(['post-9']).get('post-9'), anonymousPersona('post-9'))
  assert.equal(assignAnonymousPersonas([...ids, 'reply-99']).size, 17)
})

test('role labels and avatar urls stay inside the profile rules', () => {
  assert.equal(roleLabel('committee'), '领航执委会')
  assert.equal(roleLabel('mentor'), '领航导师')
  assert.equal(roleLabel('student', ' 2025 春季班 '), '领航学员 · 2025 春季班')
  assert.equal(roleLabel('other'), '其他成员')
  assert.equal(roleLabel(null), '')
  assert.equal(roleLabel('student', ''), '领航学员')

  const path = '11111111-1111-1111-1111-111111111111.webp'
  assert.equal(isUploadedAvatar(path), true)
  assert.equal(isUploadedAvatar('https://example.com/a.png'), false)
  assert.equal(
    displayAvatarUrl(path, 'https://project.supabase.co'),
    `https://project.supabase.co/storage/v1/object/public/avatars/${path}`,
  )
  assert.equal(displayAvatarUrl(path, ''), null)
  assert.equal(displayAvatarUrl('../secret.webp', 'https://project.supabase.co'), null)
  assert.equal(displayAvatarUrl('https://lh3.googleusercontent.com/a/photo'), 'https://lh3.googleusercontent.com/a/photo')
})

test('avatar URLs only allow http and https', () => {
  assert.equal(safeAvatarUrl('javascript:alert(1)'), null)
  assert.equal(safeAvatarUrl('data:text/html,bad'), null)
  assert.equal(safeAvatarUrl('https://example.com/avatar.png'), 'https://example.com/avatar.png')
})

test('invite codes are trimmed and upper-cased', () => {
  assert.equal(normalizeInviteCode('  demo2026  '), 'DEMO2026')
  assert.equal(normalizeInviteCode(null), '')
  assert.deepEqual(validateInviteCode('  demo2026  '), { ok: true, value: 'DEMO2026' })
  assert.equal(validateInviteCode('   ').ok, false)
  assert.equal(validateInviteCode('').ok, false)
})

test('post deep links keep only a valid post id', () => {
  assert.equal(normalizePostId(' 42 '), '42')
  assert.equal(normalizePostId('0'), null)
  assert.equal(normalizePostId('42x'), null)
  assert.equal(postIdFromSearch('?post=42&code=oauth-code'), '42')
  assert.equal(postIdFromSearch('?post=bad'), null)
  assert.equal(
    postUrl('https://example.com/situational_awareness/?post=7&code=secret#token', 42),
    'https://example.com/situational_awareness/?post=42',
  )
  assert.equal(
    postUrl('https://example.com/situational_awareness/?post=7#token'),
    'https://example.com/situational_awareness/',
  )
  assert.equal(
    postUrl('https://example.com/situational_awareness/?backend=mongo&post=7&code=secret#token', 42),
    'https://example.com/situational_awareness/?backend=mongo&post=42',
  )
  assert.equal(
    postUrl('https://example.com/situational_awareness/?backend=supabase&post=7', 42),
    'https://example.com/situational_awareness/?post=42',
  )
})

test('business storage keys keep Supabase names and isolate Mongo data', () => {
  const key = 'situational-awareness-drafts:user-1'
  assert.equal(backendStorageKey(key, 'supabase'), key)
  assert.equal(backendStorageKey(key, 'demo'), key)
  assert.equal(backendStorageKey(key, 'mongo'), `${key}:mongo`)
})

test('copied post links put the title above the URL', () => {
  assert.equal(
    postShareText('在亚麻呆到第三年 每周哭三次', 'https://example.com/?post=42'),
    '在亚麻呆到第三年 每周哭三次\nhttps://example.com/?post=42',
  )
  assert.equal(postShareText('', 'https://example.com/'), 'https://example.com/')
})

test('unread replies only count other people after a participated post was seen', () => {
  const lastSeen = '2026-10-13T12:00:00Z'
  const replies = [
    { id: 1, is_mine: true, created_at: '2026-10-13T11:00:00Z' },
    { id: 2, is_mine: false, created_at: '2026-10-13T11:30:00Z' },
    { id: 3, is_mine: false, created_at: '2026-10-13T12:30:00Z' },
    { id: 4, is_mine: true, created_at: '2026-10-13T13:00:00Z' },
  ]
  assert.equal(unreadReplyCount({ is_mine: false, replies }, lastSeen), 1)
  assert.equal(unreadReplyCount({ is_mine: true, replies: replies.slice(1, 3) }, lastSeen), 1)
  assert.equal(unreadReplyCount({ is_mine: false, replies: replies.slice(1, 3) }, lastSeen), 0)
  assert.equal(unreadReplyCount({ is_mine: true, replies }, 'not-a-date'), 0)
})

test('absolute time is empty for invalid input and includes the year otherwise', () => {
  assert.equal(formatAbsoluteTime('not-a-date'), '')
  assert.match(formatAbsoluteTime('2026-10-13T15:04:00Z'), /2026/)
})

test('a reply is new only for other people, after the last visit, on a thread you joined', () => {
  const post = {
    is_mine: true,
    replies: [
      { id: 1, is_mine: false, created_at: '2026-10-13T12:00:00Z' },
      { id: 2, is_mine: true, created_at: '2026-10-13T13:00:00Z' },
    ],
  }
  const seen = new Date('2026-10-13T11:00:00Z').getTime()
  assert.equal(isNewReply(post, post.replies[0], seen), true)
  assert.equal(isNewReply(post, post.replies[1], seen), false)
  assert.equal(isNewReply(post, post.replies[0], new Date('2026-10-13T12:30:00Z').getTime()), false)
  assert.equal(isNewReply({ is_mine: false, replies: [post.replies[0]] }, post.replies[0], seen), false)
})

test('the op badge requires the same author and the same anonymity', () => {
  assert.equal(replyIsFromOp(true, true, true), true)
  assert.equal(replyIsFromOp(false, false, true), true)
  assert.equal(replyIsFromOp(true, false, true), false)
  assert.equal(replyIsFromOp(false, true, true), false)
  assert.equal(replyIsFromOp(true, true, false), false)
})

test('late night runs from 23:00 to before 05:00 local time', () => {
  const at = (hour) => new Date(2026, 9, 13, hour, 30)
  assert.equal(isLateNight(at(22)), false)
  assert.equal(isLateNight(at(23)), true)
  assert.equal(isLateNight(at(0)), true)
  assert.equal(isLateNight(at(4)), true)
  assert.equal(isLateNight(at(5)), false)
})

test('milestones need someone else to answer or vote', () => {
  assert.deepEqual(reachedMilestones([]), [])
  assert.deepEqual(reachedMilestones([
    { is_mine: true, upvote_count: 1, liked_by_me: true, replies: [{ is_mine: true, upvote_count: 1, liked_by_me: true }] },
  ]), [])
  assert.deepEqual(reachedMilestones([
    { is_mine: false, upvote_count: 5, replies: [{ is_mine: false, upvote_count: 3 }] },
  ]), [])
  assert.deepEqual(reachedMilestones([
    { is_mine: true, upvote_count: 2, liked_by_me: true, replies: [{ is_mine: false, upvote_count: 0 }] },
    { is_mine: false, upvote_count: 0, replies: [{ is_mine: true, upvote_count: 1, liked_by_me: false }] },
  ]), ['firstAnswer', 'firstGoodQuestion', 'firstReplyUpvote'])
})

test('display names and initials have safe fallbacks', () => {
  assert.equal(displayName({ user_metadata: { full_name: '  Helena Li  ' } }), 'Helena Li')
  assert.equal(displayName({ user_metadata: {} }), 'Google 用户')
  assert.equal(initials('Helena Li'), 'HL')
  assert.equal(initials('小明'), '小明')
})

test('replies sort by upvote count then oldest first', () => {
  const replies = [
    { id: 2, created_at: '2026-09-15T10:00:00Z', upvote_count: 0, body: 'new zero' },
    { id: 3, created_at: '2026-09-15T12:00:00Z', upvote_count: 3, body: 'newer high' },
    { id: 1, created_at: '2026-09-15T08:00:00Z', upvote_count: 3, body: 'older high' },
  ]

  assert.deepEqual(
    sortReplies(replies).map((reply) => reply.id),
    [1, 3, 2],
  )
  assert.equal(replies[0].id, 2)
})

test('vote state clamps negative counts and coerces liked to a boolean', () => {
  assert.deepEqual(withVoteState({ id: 1, upvote_count: 2, is_mine: true, updated_at: '2026-09-19T12:00:00Z' }, true), {
    id: 1,
    upvote_count: 2,
    is_mine: true,
    updated_at: '2026-09-19T12:00:00Z',
    liked_by_me: true,
  })
  assert.deepEqual(withVoteState({ id: 2, upvote_count: -3 }, undefined), {
    id: 2,
    upvote_count: 0,
    liked_by_me: false,
  })
})

test('markdown renders emphasis, lists, line breaks and safe links', () => {
  const html = renderMarkdown('请看 **重点** 和 [说明](https://example.com/path)\n下一行\n\n- 选项 A\n- 选项 B')
  assert.match(html, /<strong>重点<\/strong>/)
  assert.match(html, /href="https:\/\/example.com\/path"/)
  assert.match(html, /rel="noopener noreferrer nofollow"/)
  assert.match(html, /target="_blank"/)
  assert.match(html, /下一行/)
  assert.match(html, /<li>选项 A<\/li>/)
  assert.match(html, /<br>/)
})

test('markdown keeps existing plain text readable', () => {
  const html = renderMarkdown('第一行\n第二行')
  assert.match(html, /第一行<br>第二行/)
  assert.equal(renderMarkdown('1 < 2 & 3').includes('<script'), false)
  assert.match(renderMarkdown('1 < 2 & 3'), /1 &lt; 2 &amp; 3/)
})

test('markdown strips raw HTML, images and unsafe URLs', () => {
  const html = renderMarkdown(
    '<script>alert(1)</script>\n[x](javascript:alert(1))\n[y](data:text/html,hi)\n![pic](https://evil.example/x.png)',
  )
  assert.doesNotMatch(html, /<script/i)
  assert.doesNotMatch(html, /javascript:/i)
  assert.doesNotMatch(html, /data:/i)
  assert.doesNotMatch(html, /<img/i)
  assert.match(html, />x</)
  assert.match(html, /pic/)
})

test('markdown only allows http(s) and mailto links', () => {
  assert.equal(safeHref('https://example.com'), 'https://example.com/')
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.equal(safeHref('//evil.example'), null)
  assert.equal(safeHref('mailto:a@example.com'), 'mailto:a@example.com')

  const html = renderMarkdown('[a](//evil.example) [b](vbscript:x)')
  assert.doesNotMatch(html, /href="/)
})

test('plain excerpts strip markdown and respect unicode length', () => {
  assert.equal(excerptPlain('我会先把 **接项目** 和 **接受** 拆开。'), '我会先把接项目和接受拆开。')
  assert.equal(excerptPlain('先验证。不急着承诺。'), '先验证。不急着承诺。')
  assert.equal(excerptPlain('[看这里](https://example.com) 就行'), '看这里就行')
  assert.equal(excerptPlain('一二三四五', 3), '一二三…')
  assert.equal(excerptPlain('这句话后面还有很多补充说明，不能只留第一句。', 8), '这句话后面还有很…')
  assert.equal(excerptPlain('   '), '')
})

test('markdown headings do not outrank the post title', () => {
  const html = renderMarkdown('# 太大\n## 二级')
  assert.doesNotMatch(html, /<h[1-6]/)
  assert.match(html, /<strong>太大<\/strong>/)
  assert.match(html, /<strong>二级<\/strong>/)
})

test('threads retain exact targets, sort roots by votes, and children by time', () => {
  const replies = [
    { id: 1, post_id: 1, upvote_count: 1, created_at: '2026-01-01' },
    { id: 2, post_id: 1, parent_reply_id: 1, upvote_count: 99, created_at: '2026-01-02' },
    { id: 3, post_id: 1, parent_reply_id: 2, created_at: '2026-01-03' },
    { id: 4, post_id: 1, upvote_count: 2, created_at: '2026-01-04' },
  ]
  const threads = groupReplyThreads([replies[2], replies[3], replies[1], replies[0]])
  assert.deepEqual(threads.map(t => t.root.id), [4, 1])
  assert.deepEqual(threads[1].children.map(r => r.id), [2, 3])
  assert.equal(threads[1].children[1].parent_reply_id, 2)
})

test('legacy replies, missing parents and cross-post parents remain visible', () => {
  const replies = [
    { id: 1, post_id: 1 },
    { id: 2, post_id: 1, parent_reply_id: 999 },
    { id: 3, post_id: 2, parent_reply_id: 1 },
  ]
  assert.deepEqual(groupReplyThreads(replies).map(t => t.root.id), [1, 2, 3])
})
