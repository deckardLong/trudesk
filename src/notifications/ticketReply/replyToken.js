/*
 * Reply-To token cho email thông báo ticket.
 *
 * Email gửi cho người dùng có Reply-To dạng:
 *     support+t1042.9f3a1c7b2e@acme.vn
 * Khi người dùng bấm "Trả lời", thư quay về hộp IMAP. mailCheck đọc địa chỉ To,
 * kiểm tra chữ ký HMAC rồi ghép nội dung vào ticket #1042 thay vì tạo ticket mới.
 *
 * Chữ ký ngăn người ngoài đoán địa chỉ để chèn comment vào ticket của người khác.
 */

const crypto = require('crypto')

const SIG_LENGTH = 10
const TOKEN_RE = /^t(\d+)\.([a-f0-9]+)$/i

function sign (uid, secret) {
  if (!secret) throw new Error('replyToken: secret is required')
  return crypto
    .createHmac('sha256', String(secret))
    .update('ticket-reply:' + String(uid))
    .digest('hex')
    .slice(0, SIG_LENGTH)
}

function safeEqual (a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * @param {Object} opts
 * @param {Number} opts.uid       Mã ticket (ticket.uid)
 * @param {String} opts.mailbox   Hộp thư nhận (vd support@acme.vn), là hộp IMAP đang được quét
 * @param {String} opts.secret    Khóa HMAC
 * @returns {String|null} địa chỉ Reply-To, hoặc null nếu mailbox không hợp lệ
 */
function buildReplyAddress ({ uid, mailbox, secret }) {
  if (!mailbox || mailbox.indexOf('@') === -1) return null
  const [local, domain] = mailbox.split('@')
  const baseLocal = local.split('+')[0]
  return `${baseLocal}+t${uid}.${sign(uid, secret)}@${domain}`
}

/**
 * Tách token từ một địa chỉ email.
 * @returns {{uid: Number}|null} null nếu không có token hoặc chữ ký sai
 */
function parseReplyAddress (address, secret) {
  if (!address || typeof address !== 'string') return null
  const local = address.trim().toLowerCase().split('@')[0]
  const plusIndex = local.indexOf('+')
  if (plusIndex === -1) return null

  const tag = local.slice(plusIndex + 1)
  const match = TOKEN_RE.exec(tag)
  if (!match) return null

  const uid = Number(match[1])
  if (!safeEqual(match[2], sign(uid, secret))) return null

  return { uid }
}

/** Tìm token hợp lệ đầu tiên trong danh sách địa chỉ (To, Cc, Delivered-To). */
function findTokenInAddresses (addresses, secret) {
  for (const addr of addresses || []) {
    const parsed = parseReplyAddress(addr, secret)
    if (parsed) return parsed
  }
  return null
}

module.exports = { sign, buildReplyAddress, parseReplyAddress, findTokenInAddresses }
