/*
 * Tiện ích giao diện cho phản hồi tự động của AI Agent.
 * Nhãn dùng chung với server (email) để hai nơi luôn khớp.
 */

import autoReplyKinds from '../../notifications/ticketReply/autoReplyKinds'

const KINDS = autoReplyKinds.KINDS
const detectKind = autoReplyKinds.detectKind

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&middot;': '·', '&nbsp;': ' ' }

export function htmlToText (html) {
  return String(html || '')
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|middot|nbsp);/g, m => ENTITIES[m])
    .trim()
}

export function escapeHtml (text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Nhận diện comment do AI gửi (dòng đầu là nhãn) và tách nhãn khỏi nội dung.
 * @returns {{ kind, label, webIcon, color, bodyHtml } | null}
 */
export function parseAutoReply (html) {
  const auto = detectKind(htmlToText(html))
  if (!auto) return null
  const escaped = auto.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('·', '(?:·|&middot;)')
  const re = new RegExp(`^\\s*(<p>\\s*)?${escaped}\\s*(</p>|<br\\s*/?>)?\\s*`)
  // Nhãn là cả đoạn <p>…</p> -> bỏ hẳn; nhãn cùng đoạn với nội dung (ngăn bằng <br>) -> giữ lại thẻ <p> mở
  const bodyHtml = String(html).replace(re, (m, open, close) => (open && (!close || /^<br/i.test(close)) ? '<p>' : ''))
  return Object.assign({}, auto, { bodyHtml })
}

export { KINDS }
