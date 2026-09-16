import assert from 'node:assert/strict'
import test from 'node:test'

import {
  displayName,
  formatRelativeTime,
  initials,
  safeAvatarUrl,
  sortReplies,
  validatePost,
  validateReply,
  withVoteState,
} from '../src/lib.js'

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
    value: { body: '一个建议' },
  })
  assert.equal(validateReply(' ').ok, false)
  assert.equal(validateReply('a'.repeat(2001)).ok, false)
})

test('relative time handles recent, hourly, daily and invalid dates', () => {
  const now = Date.parse('2026-09-13T12:00:00Z')
  assert.equal(formatRelativeTime('2026-09-13T11:59:40Z', now), '刚刚')
  assert.equal(formatRelativeTime('2026-09-13T11:20:00Z', now), '40 分钟前')
  assert.equal(formatRelativeTime('2026-09-13T08:00:00Z', now), '4 小时前')
  assert.equal(formatRelativeTime('2026-09-11T12:00:00Z', now), '2 天前')
  assert.equal(formatRelativeTime('not-a-date', now), '刚刚')
})

test('avatar URLs only allow http and https', () => {
  assert.equal(safeAvatarUrl('javascript:alert(1)'), null)
  assert.equal(safeAvatarUrl('data:text/html,bad'), null)
  assert.equal(safeAvatarUrl('https://example.com/avatar.png'), 'https://example.com/avatar.png')
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
  assert.deepEqual(withVoteState({ id: 1, upvote_count: 2 }, true), {
    id: 1,
    upvote_count: 2,
    liked_by_me: true,
  })
  assert.deepEqual(withVoteState({ id: 2, upvote_count: -3 }, undefined), {
    id: 2,
    upvote_count: 0,
    liked_by_me: false,
  })
})
