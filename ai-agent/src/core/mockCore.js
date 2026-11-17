/*
 * Trudesk Core GIẢ LẬP (trong bộ nhớ) – phần do người A làm, mô phỏng để chạy demo không cần MongoDB:
 *
 *   POST  /api/v2/tickets/:uid/ai-suggestions   -> postSuggestion()   (lưu status=pending, phát ai:suggestion:new)
 *   PATCH /api/v2/tickets/:uid  applyAISuggestions -> reviewSuggestion() (agent duyệt từng trường / dùng nháp)
 *   job hết hạn gợi ý                              -> expireSuggestions()
 *
 * Khi agent dùng nháp trả lời, Core tạo comment công khai và phát `ticket:comment:added`
 * -> Ticket Reply Notifier gửi thông báo web + email cho người dùng (xem demo/e2e).
 */

const { EventEmitter } = require('events')

class MockCore extends EventEmitter {
  constructor ({ now = () => Date.now(), botUserId = 'u-ai-bot' } = {}) {
    super()
    this.now = now
    this.botUserId = botUserId
    this.tickets = new Map()
    this.suggestions = new Map()
    this.audit = []
    this.seq = 0
  }

  addTicket (ticket) {
    this.tickets.set(ticket.uid, { history: [], comments: [], ...ticket })
  }

  async getTicket (uid) {
    return this.tickets.get(uid) || null
  }

  /** AI gọi: ghi gợi ý chờ duyệt. Áp ngay các trường decision='auto' (Cách 3, nếu bật). */
  async postSuggestion (uid, suggestion) {
    const ticket = this.tickets.get(uid)
    if (!ticket) throw new Error(`ticket #${uid} not found`)

    const id = `sug-${++this.seq}`
    const doc = { id, ticketUid: uid, status: 'pending', createdAt: this.now(), ...suggestion }
    this.suggestions.set(id, doc)

    const autoFields = Object.entries(doc.fields || {}).filter(([, f]) => f.decision === 'auto')
    for (const [key, f] of autoFields) {
      ticket[key] = f.value
      ticket.history.push({ action: `ticket:ai:auto:${key}`, description: `AI tự áp dụng ${key} = ${f.value}`, by: 'ai-agent' })
    }

    this.emit('ai:suggestion:new', { ticketUid: uid, suggestionId: id })
    return doc
  }

  /**
   * Agent duyệt gợi ý (sơ đồ 2, bước 10-12).
   * @param {String} id
   * @param {Object} review { agent: {id, name}, acceptFields: String[], useDraft: Boolean, editedDraft?: String, rejectReason?: String }
   */
  async reviewSuggestion (id, review) {
    const doc = this.suggestions.get(id)
    if (!doc) throw new Error('suggestion not found')
    if (doc.status !== 'pending') throw new Error(`suggestion is ${doc.status}`)
    const ticket = this.tickets.get(doc.ticketUid)

    const accepted = (review.acceptFields || []).filter(k => doc.fields[k] && doc.fields[k].decision === 'pending')
    for (const k of accepted) {
      ticket[k] = doc.fields[k].value
      ticket.history.push({ action: `ticket:ai:approved:${k}`, description: `${review.agent.name} duyệt gợi ý AI: ${k}`, by: review.agent.id })
    }

    let comment = null
    if (review.useDraft && doc.replyDraft && doc.replyDraft.decision === 'pending') {
      comment = {
        _id: `${doc.ticketUid}-${++this.seq}`,
        owner: review.agent.id,
        date: new Date(this.now()),
        comment: (review.editedDraft || doc.replyDraft.text)
          .split('\n')
          .map(l => (l ? `<p>${escape(l)}</p>` : ''))
          .join('')
      }
      ticket.comments.push(comment)
      ticket.history.push({ action: 'ticket:comment:added', description: `${review.agent.name} gửi trả lời (từ nháp AI)`, by: review.agent.id })
    }

    const nothing = accepted.length === 0 && !comment
    doc.status = nothing ? 'rejected' : 'approved'
    doc.reviewedAt = this.now()
    doc.reviewedBy = review.agent.id
    doc.acceptedFields = accepted
    doc.rejectReason = nothing ? review.rejectReason || 'không dùng' : undefined

    this.audit.push({ at: this.now(), suggestionId: id, agent: review.agent.id, accepted, usedDraft: !!comment, status: doc.status })

    if (comment) this.emit('ticket:comment:added', { ticket, comment })
    return doc
  }

  /** AI gửi phản hồi công khai (giống POST /api/v1/tickets/addcomment bằng token của tài khoản AI). */
  async postComment (uid, text) {
    const ticket = this.tickets.get(uid)
    if (!ticket) throw new Error(`ticket #${uid} not found`)
    const comment = { _id: `${uid}-${++this.seq}`, owner: this.botUserId, date: new Date(this.now()), comment: textToHtml(text) }
    ticket.comments.push(comment)
    ticket.history.push({ action: 'ticket:comment:added', description: 'Trợ lý AI gửi phản hồi tự động', by: this.botUserId })
    this.emit('ticket:comment:added', { ticket, comment })
    return comment
  }

  /** Người dùng/agent thêm comment (demo dùng cho email trả lời đi vào). */
  async addUserComment (uid, ownerId, text) {
    const ticket = this.tickets.get(uid)
    const comment = { _id: `${uid}-${++this.seq}`, owner: ownerId, date: new Date(this.now()), comment: textToHtml(text) }
    ticket.comments.push(comment)
    this.emit('ticket:comment:added', { ticket, comment })
    return comment
  }

  async addNote (uid, text) {
    const ticket = this.tickets.get(uid)
    ticket.notes = ticket.notes || []
    ticket.notes.push({ owner: this.botUserId, date: new Date(this.now()), note: textToHtml(text) })
  }

  async setStatus (uid, statusName) {
    const ticket = this.tickets.get(uid)
    const isResolved = /closed|resolved/i.test(statusName)
    ticket.status = { name: statusName, isResolved }
    ticket.closedDate = isResolved ? new Date(this.now()) : null
    ticket.history.push({ action: `ticket:set:status:${statusName}`, description: `Trạng thái: ${statusName}`, by: this.botUserId })
  }

  /** Envelope ticket.updated giống aiEventPublisher của Core. */
  toUpdatedEvent (uid, id) {
    const t = this.tickets.get(uid)
    return {
      id: id || `ticket.updated:${uid}:${t.comments.length}`,
      type: 'ticket.updated',
      version: 1,
      data: {
        ticket: {
          uid,
          subject: t.subject,
          issue: t.issue,
          group: t.group,
          status: t.status && t.status.name,
          comments: t.comments.map(c => ({
            text: c.comment,
            authorRole: c.owner === this.botUserId ? 'ai' : c.owner === t.owner ? 'user' : 'agent'
          }))
        }
      }
    }
  }

  expireSuggestions () {
    const expired = []
    for (const doc of this.suggestions.values()) {
      if (doc.status === 'pending' && doc.expiresAt && doc.expiresAt <= this.now()) {
        doc.status = 'expired'
        expired.push(doc.id)
      }
    }
    return expired
  }

  pendingFor (uid) {
    return Array.from(this.suggestions.values()).filter(s => s.ticketUid === uid && s.status === 'pending')
  }
}

function escape (s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function textToHtml (text) {
  return String(text)
    .split('\n')
    .map(l => (l ? `<p>${escape(l)}</p>` : ''))
    .join('')
}

module.exports = { MockCore }
