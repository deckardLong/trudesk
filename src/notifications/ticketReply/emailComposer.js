/*
 * Soạn email "ticket có phản hồi mới".
 *
 * Thiết kế:
 *  - Subject cố định theo ticket: "[Ticket #1042] Re: <tiêu đề>" -> mail client gom thành một luồng.
 *  - Message-ID riêng cho mỗi email, In-Reply-To/References trỏ về "<ticket-1042@domain>"
 *    -> Gmail/Outlook hiển thị đúng thread.
 *  - Reply-To có token ký HMAC (xem replyToken.js) -> người dùng trả lời thẳng từ hộp thư.
 *  - Dòng đánh dấu REPLY_MARKER: inbound parser cắt mọi thứ bên dưới dòng này
 *    (lịch sử trích dẫn), chỉ giữ phần người dùng mới viết.
 *  - Gộp nhiều phản hồi (debounce) vào một email.
 *  - Không bao giờ chứa internal note (đã lọc ở recipientResolver và notifier).
 */

const { iconAttachment } = require('./icons')
const { detectKind } = require('./autoReplyKinds')

const REPLY_MARKER = '##- Vui lòng trả lời phía trên dòng này -##'

function escapeHtml (str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function htmlToText (html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Bỏ đoạn HTML đầu tiên chứa nhãn (<p>nhãn</p>, hoặc dòng nhãn kết thúc bằng <br>). */
function removeFirstLine (html, label) {
  const s = String(html || '')
  const escaped = escapeHtml(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s*(<p>\\s*)?${escaped}\\s*(</p>|<br\\s*/?>)?\\s*`)
  // Nhãn là cả đoạn <p>…</p> -> bỏ hẳn; nhãn cùng đoạn với nội dung (ngăn bằng <br>) -> giữ lại thẻ <p> mở
  return re.test(s) ? s.replace(re, (m, open, close) => (open && (!close || /^<br/i.test(close)) ? '<p>' : '')) : s
}

function domainOf (address, fallback) {
  if (address && address.indexOf('@') !== -1) return address.split('@')[1]
  return fallback || 'trudesk.local'
}

function formatDate (d) {
  const date = d instanceof Date ? d : new Date(d)
  if (isNaN(date.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
}

function ticketThreadId (ticket, domain) {
  return `<ticket-${ticket.uid}@${domain}>`
}

/**
 * @param {Object} args
 * @param {Object} args.ticket       { _id, uid, subject, status: { name } }
 * @param {Array}  args.comments     [{ _id, authorName, date, html }]
 * @param {Object} args.recipient    { email, fullname }
 * @param {String} args.siteUrl      vd https://helpdesk.acme.vn
 * @param {String|null} args.replyTo địa chỉ Reply-To có token (null -> người dùng phải trả lời trên web)
 * @param {String} args.mailbox      hộp thư hệ thống, dùng lấy domain cho Message-ID
 */
function composeReplyEmail ({ ticket, comments, recipient, siteUrl, replyTo, mailbox }) {
  if (!comments || comments.length < 1) throw new Error('composeReplyEmail: comments is empty')

  const domain = domainOf(mailbox)
  const ticketUrl = `${String(siteUrl || '').replace(/\/$/, '')}/tickets/${ticket.uid}`
  const count = comments.length
  const lastComment = comments[count - 1]
  const statusName = ticket.status && ticket.status.name ? ticket.status.name : ''

  const subject = `[Ticket #${ticket.uid}] Re: ${ticket.subject}`
  // Người tạo ticket: "ticket của bạn"; agent/người theo dõi: nêu số ticket.
  const forOwner = !recipient.reason || recipient.reason === 'owner'
  const which = forOwner ? 'ticket của bạn' : `ticket #${ticket.uid}`
  const intro =
    count === 1
      ? `${lastComment.authorName} đã phản hồi ${which}.`
      : `${forOwner ? 'Ticket của bạn' : `Ticket #${ticket.uid}`} có ${count} phản hồi mới.`

  // Icon lấy từ bộ Material Design Icons của Trudesk, đính kèm nội tuyến (CID), không tải từ web.
  const attachments = new Map()
  const icon = (name, color, size = 20) => {
    const att = iconAttachment(name, { color, size: size * 2 })
    attachments.set(att.cid, att)
    return `<img src="cid:${att.cid}" width="${size}" height="${size}" alt="" style="vertical-align:middle;border:0;display:inline-block">`
  }

  const commentBlocksHtml = comments
    .map(c => {
      // Phản hồi tự động: dòng nhãn đầu tiên được thay bằng icon + nhãn
      const auto = detectKind(htmlToText(c.html))
      const body = auto ? removeFirstLine(c.html, auto.label) : c.html
      const accent = auto ? auto.color : '#2b5ea7'
      const header = auto
        ? `<div style="margin-bottom:6px">${icon(auto.icon, auto.color)}<strong style="color:${auto.color};vertical-align:middle;margin-left:6px">${escapeHtml(auto.label)}</strong></div>`
        : ''
      return `
      <div style="border-left:3px solid ${accent};padding:8px 12px;margin:12px 0;background:#f6f8fb">
        ${header}
        <div style="font-size:12px;color:#555;margin-bottom:6px">
          <strong>${escapeHtml(c.authorName)}</strong> · ${escapeHtml(formatDate(c.date))}
        </div>
        <div>${body}</div>
      </div>`
    })
    .join('')
  const ticketIcon = icon('action-assignment', '#555555', 16)

  const replyHint = replyTo
    ? 'Bạn có thể trả lời trực tiếp email này, hoặc mở ticket trên web.'
    : 'Vui lòng mở ticket trên web để trả lời.'

  const html = `<!doctype html>
<html><body style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
  <div style="color:#999;font-size:11px">${escapeHtml(REPLY_MARKER)}</div>
  <p>Xin chào ${escapeHtml(recipient.fullname || recipient.email)},</p>
  <p>${escapeHtml(intro)}</p>
  <p style="margin:4px 0">${ticketIcon} <strong style="vertical-align:middle">Ticket #${ticket.uid}:</strong> <span style="vertical-align:middle">${escapeHtml(ticket.subject)}</span></p>
  ${statusName ? `<p style="margin:4px 0"><strong>Trạng thái:</strong> ${escapeHtml(statusName)}</p>` : ''}
  ${commentBlocksHtml}
  <p><a href="${escapeHtml(ticketUrl)}" style="background:#2b5ea7;color:#fff;padding:8px 14px;text-decoration:none;border-radius:4px">Xem ticket trên web</a></p>
  <p style="color:#666;font-size:12px">${escapeHtml(replyHint)}</p>
</body></html>`

  const text = [
    REPLY_MARKER,
    '',
    `Xin chào ${recipient.fullname || recipient.email},`,
    '',
    intro,
    `Ticket #${ticket.uid}: ${ticket.subject}`,
    statusName ? `Trạng thái: ${statusName}` : null,
    '',
    ...comments.map(c => `--- ${c.authorName} · ${formatDate(c.date)} ---\n${htmlToText(c.html)}\n`),
    `Xem ticket: ${ticketUrl}`,
    replyHint
  ]
    .filter(line => line !== null)
    .join('\n')

  const threadId = ticketThreadId(ticket, domain)
  const lastId = lastComment._id ? String(lastComment._id) : String(Date.now())

  const message = {
    to: recipient.email,
    subject,
    html,
    text,
    messageId: `<ticket-${ticket.uid}-c-${lastId}@${domain}>`,
    inReplyTo: threadId,
    references: [threadId],
    headers: {
      'X-Trudesk-Ticket': String(ticket.uid),
      'Auto-Submitted': 'auto-generated'
    }
  }
  if (replyTo) message.replyTo = replyTo
  if (attachments.size) message.attachments = Array.from(attachments.values())

  return message
}

module.exports = { composeReplyEmail, htmlToText, escapeHtml, REPLY_MARKER, ticketThreadId }
