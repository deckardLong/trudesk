/*
 * Client gọi Trudesk Core thật qua HTTP bằng token riêng của service AI.
 * AI KHÔNG đọc MongoDB trực tiếp (nguyên tắc trong expansion-plan.md).
 *
 * Chỉ dùng API v1 (header `accesstoken`). API v2 xác thực bằng JWT, và /api/v2/login, /api/v2/token
 * của Trudesk 1.2.11 có lỗi (await một hàm chỉ hỗ trợ callback) nên service không lấy được JWT.
 *
 * suggestionSink:
 *   'internal-note' (mặc định): ghi gợi ý thành internal note qua API có sẵn POST /api/v1/tickets/addnote.
 *                               Chạy được ngay, không cần sửa Core. Chỉ nhân viên thấy note.
 *   'endpoint'                : POST /api/v1/tickets/:uid/ai-suggestions (endpoint đề xuất, người A bổ sung).
 */

const axios = require('axios')

function formatNote (s) {
  const label = { pending: 'chờ duyệt', auto: 'đã tự áp dụng', dropped: 'bỏ qua' }
  const lines = ['**Gợi ý từ AI** (cần agent kiểm tra trước khi áp dụng)', '']
  for (const [k, f] of Object.entries(s.fields || {})) {
    if (f.decision === 'dropped') continue
    const v = Array.isArray(f.value) ? f.value.join(', ') : f.value
    lines.push(`- **${k}**: ${v} (${f.confidence.toFixed(2)}, ${label[f.decision]})`)
  }
  if (s.similarTickets && s.similarTickets.length) {
    lines.push('', '**Ticket tương tự:** ' + s.similarTickets.map(t => `${t.ref} (${t.relation})`).join(', '))
  }
  if (s.replyDraft && s.replyDraft.decision === 'pending') {
    lines.push('', `**Nháp trả lời** (nguồn: ${s.replyDraft.citations.join(', ') || 'không có'}):`, '', s.replyDraft.text)
  }
  return lines.join('\n')
}

class HttpCore {
  constructor ({ baseUrl, accessToken, suggestionSink = 'internal-note', timeoutMs = 5000, http }) {
    if (!accessToken) throw new Error('HttpCore: TRUDESK_AI_TOKEN is required')
    this.sink = suggestionSink
    this.http = http || axios.create({
      baseURL: baseUrl.replace(/\/$/, ''),
      timeout: timeoutMs,
      headers: { accesstoken: accessToken, 'Content-Type': 'application/json' }
    })
  }

  async getTicket (uid) {
    const res = await this.http.get(`/api/v1/tickets/${uid}`)
    return res.data && res.data.success && res.data.ticket ? res.data.ticket : null
  }

  /** Phản hồi công khai bằng tài khoản AI (token). Core phát ticket:comment:added -> người dùng nhận web + email. */
  async postComment (uid, text) {
    const ticket = await this.requireTicket(uid)
    const res = await this.http.post('/api/v1/tickets/addcomment', { _id: ticket._id, comment: text })
    return res.data
  }

  async addNote (uid, text) {
    const ticket = await this.requireTicket(uid)
    const res = await this.http.post('/api/v1/tickets/addnote', { ticketid: ticket._id, note: text })
    return res.data
  }

  async setStatus (uid, statusName) {
    const ticket = await this.requireTicket(uid)
    if (!this.statuses) {
      const res = await this.http.get('/api/v1/tickets/status')
      this.statuses = res.data.status || []
    }
    const status = this.statuses.find(s => String(s.name).toLowerCase() === statusName.toLowerCase())
    if (!status) throw new Error(`status "${statusName}" không tồn tại`)
    // PUT /api/v1/tickets/:id nhận status và closedDate (đóng thì ghi ngày đóng, mở lại thì xóa)
    await this.http.put(`/api/v1/tickets/${ticket._id}`, {
      status: status._id,
      closedDate: status.isResolved ? new Date().toISOString() : null
    })
  }

  async requireTicket (uid) {
    const ticket = await this.getTicket(uid)
    if (!ticket) throw new Error(`ticket #${uid} not found`)
    return ticket
  }

  async postSuggestion (uid, suggestion) {
    if (this.sink === 'endpoint') {
      const res = await this.http.post(`/api/v1/tickets/${uid}/ai-suggestions`, suggestion)
      return res.data
    }
    const ticket = await this.getTicket(uid)
    if (!ticket) throw new Error(`ticket #${uid} not found`)
    const res = await this.http.post('/api/v1/tickets/addnote', { ticketid: ticket._id, note: formatNote(suggestion) })
    return res.data
  }
}

module.exports = { HttpCore, formatNote }
