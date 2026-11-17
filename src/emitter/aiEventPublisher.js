/*
 * Hook nhỏ phía Core (vùng của người B trong expansion-plan.md): đẩy sự kiện ticket sang AI Agent Service.
 *
 * - Chỉ bật khi đặt AI_AGENT_WEBHOOK_URL (vd http://localhost:8200/events). Không đặt -> không làm gì.
 * - Gửi bất đồng bộ, timeout ngắn, lỗi chỉ ghi log: AI chậm hoặc chết KHÔNG ảnh hưởng tạo ticket.
 * - Payload tối thiểu (không gửi email/SĐT người tạo); AI tự che PII trong nội dung.
 * - Ký HMAC-SHA256 bằng AI_AGENT_WEBHOOK_SECRET ở header X-Trudesk-Signature.
 * - Tên sự kiện ra ngoài dùng dấu chấm (ticket.created) để phân biệt với emitter nội bộ (ticket:created).
 *   Khi người C chuyển sang SQS, chỉ thay hàm send(), giữ nguyên envelope.
 */

const crypto = require('crypto')
const axios = require('axios')
const winston = require('../logger')

function toPayloadTicket (t) {
  if (!t) return null
  const name = v => (v && typeof v === 'object' ? v.name : undefined)
  return {
    _id: String(t._id),
    uid: t.uid,
    subject: t.subject,
    issue: t.issue,
    group: name(t.group),
    type: name(t.type),
    priority: name(t.priority),
    status: name(t.status),
    date: t.date,
    comments: (t.comments || []).map(c => ({
      text: c.comment,
      authorRole: c.owner && t.owner && String(c.owner._id || c.owner) === String(t.owner._id || t.owner) ? 'user' : 'agent'
    }))
  }
}

function send (type, ticket) {
  const url = process.env.AI_AGENT_WEBHOOK_URL
  if (!url || !ticket) return

  const body = JSON.stringify({
    id: `${type}:${ticket.uid}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`,
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    data: { ticket: toPayloadTicket(ticket) }
  })
  const headers = { 'Content-Type': 'application/json' }
  const secret = process.env.AI_AGENT_WEBHOOK_SECRET
  if (secret) headers['X-Trudesk-Signature'] = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')

  axios.post(url, body, { headers, timeout: 3000 }).catch(err => {
    winston.warn(`[aiEventPublisher] ${type} #${ticket.uid} not delivered: ${err.message}`)
  })
}

function init (emitter) {
  if (!process.env.AI_AGENT_WEBHOOK_URL) return
  emitter.on('ticket:created', data => send('ticket.created', data && data.ticket))
  emitter.on('ticket:comment:added', ticket => send('ticket.updated', ticket))
  winston.info('[aiEventPublisher] forwarding ticket events to ' + process.env.AI_AGENT_WEBHOOK_URL)
}

module.exports = { init, toPayloadTicket }
