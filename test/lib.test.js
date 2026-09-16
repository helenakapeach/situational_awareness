import assert from 'node:assert/strict'
import test from 'node:test'

import {
  displayName,
  formatRelativeTime,
  initials,
  safeAvatarUrl,
  validatePost,
  validateReply,
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

test('markdown headings do not outrank the post title', () => {
  const html = renderMarkdown('# 太大\n## 二级')
  assert.doesNotMatch(html, /<h[1-6]/)
  assert.match(html, /<strong>太大<\/strong>/)
  assert.match(html, /<strong>二级<\/strong>/)
})
