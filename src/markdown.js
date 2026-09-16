import { Marked } from 'marked'

const HTML_ESCAPE = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPE[char])
}

export function safeHref(value) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return null

  try {
    const url = new URL(trimmed)
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') {
      return url.href
    }
  } catch {
    return null
  }

  return null
}

const marked = new Marked()

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    html() {
      return ''
    },
    checkbox({ checked }) {
      return checked ? '☑ ' : '☐ '
    },
    heading({ tokens }) {
      return `<p><strong>${this.parser.parseInline(tokens)}</strong></p>\n`
    },
    image({ text }) {
      return escapeHtml(text)
    },
    link({ href, tokens, text, autolink }) {
      const content = autolink ? escapeHtml(text) : this.parser.parseInline(tokens)
      const safe = safeHref(href)
      if (!safe) return content
      return `<a href="${escapeHtml(safe)}" rel="noopener noreferrer nofollow" target="_blank">${content}</a>`
    },
  },
})

export function renderMarkdown(source) {
  return marked.parse(String(source ?? ''), { async: false })
}
