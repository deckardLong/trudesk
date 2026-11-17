/*
 * API gợi ý của AI Agent (model src/models/aisuggestion.js).
 *
 *   POST /api/v1/tickets/:uid/ai-suggestions   AI Agent ghi gợi ý (header accesstoken của ai.assistant)
 *   GET  /api/v2/tickets/:uid/ai-suggestions   Giao diện lấy gợi ý còn hiệu lực
 *   PUT  /api/v2/ai-suggestions/:id            Giao diện ghi kết quả duyệt (trường đã áp dụng, có dùng nháp không)
 *
 * Mỗi lần thay đổi phát TICKETS_AI_SUGGESTION_UPDATE để khu "Gợi ý từ AI" đang mở tự tải lại.
 */

const _ = require('lodash')
const apiUtils = require('../apiUtils')
const AISuggestion = require('../../../models/aisuggestion')
const Ticket = require('../../../models/ticket')
const socketEvents = require('../../../socketio/socketEventConsts')

const FIELD_KEYS = ['type', 'priority', 'group', 'tags']
const DECISIONS = ['pending', 'auto', 'dropped']

function emitUpdate (ticket) {
  if (global.io) global.io.sockets.emit(socketEvents.TICKETS_AI_SUGGESTION_UPDATE, { ticketId: String(ticket._id), ticketUid: ticket.uid })
}

const clamp01 = n => (_.isFinite(Number(n)) ? Math.max(0, Math.min(1, Number(n))) : 0)
const str = (v, max) => String(v == null ? '' : v).slice(0, max)

/** Chỉ giữ các trường hợp lệ từ payload của AI (không tin dữ liệu gửi vào). */
function sanitize (body) {
  const out = { fields: {} }
  const fields = body.fields || {}
  for (const k of FIELD_KEYS) {
    const f = fields[k]
    if (!f || f.value == null) continue
    out.fields[k] = {
      value: Array.isArray(f.value) ? f.value.slice(0, 10).map(v => str(v, 50)) : str(f.value, 100),
      confidence: clamp01(f.confidence),
      decision: DECISIONS.indexOf(f.decision) !== -1 ? f.decision : 'pending'
    }
  }
  out.similarTickets = (Array.isArray(body.similarTickets) ? body.similarTickets : []).slice(0, 5).map(s => ({
    ref: str(s.ref, 20),
    relation: str(s.relation, 20),
    confidence: clamp01(s.confidence)
  }))
  if (body.replyDraft && body.replyDraft.text) {
    out.replyDraft = {
      text: str(body.replyDraft.text, 5000),
      citations: (body.replyDraft.citations || []).slice(0, 10).map(c => str(c, 20)),
      confidence: clamp01(body.replyDraft.confidence),
      decision: ['pending', 'dropped', 'auto_sent'].indexOf(body.replyDraft.decision) !== -1 ? body.replyDraft.decision : 'pending'
    }
  }
  if (body.summary && body.summary.text) {
    out.summary = { text: str(body.summary.text, 2000), confidence: clamp01(body.summary.confidence), decision: str(body.summary.decision, 20) }
  }
  if (body.autoReply) out.autoReply = { sent: !!body.autoReply.sent, kind: str(body.autoReply.kind, 20) }
  out.rationale = str(body.rationale, 1000)
  out.model = str(body.model, 100)
  const exp = Number(body.expiresAt)
  out.expiresAt = _.isFinite(exp) && exp > Date.now() ? new Date(exp) : new Date(Date.now() + 6 * 60 * 60 * 1000)
  return out
}

const aiSuggestions = {}

aiSuggestions.create = async (req, res) => {
  const uid = Number(req.params.uid)
  if (!_.isFinite(uid)) return apiUtils.sendApiError_InvalidPostData(res)

  try {
    const ticket = await Ticket.findOne({ uid, deleted: false }).select('_id uid')
    if (!ticket) return apiUtils.sendApiError(res, 404, 'Ticket not found')

    const data = sanitize(req.body || {})
    const summaryOnly = Object.keys(data.fields).length === 0 && !data.replyDraft && data.summary

    let suggestion
    const current = await AISuggestion.getActiveForTicket(uid)
    if (summaryOnly && current) {
      // Bản tóm tắt thread: gắn vào gợi ý đang chờ, không thay thế phần triage chưa duyệt
      current.summary = data.summary
      suggestion = await current.save()
    } else {
      // Gợi ý mới thay thế gợi ý cũ chưa duyệt của cùng ticket
      await AISuggestion.updateMany({ ticket: ticket._id, status: 'pending' }, { $set: { status: 'expired' } })
      suggestion = await AISuggestion.create({ ...data, ticket: ticket._id, ticketUid: uid })
    }

    emitUpdate(ticket)
    return apiUtils.sendApiSuccess(res, { suggestion })
  } catch (e) {
    return apiUtils.sendApiError(res, 500, e.message)
  }
}

aiSuggestions.getForTicket = async (req, res) => {
  const uid = Number(req.params.uid)
  if (!_.isFinite(uid)) return apiUtils.sendApiError_InvalidPostData(res)

  try {
    const suggestion = await AISuggestion.getActiveForTicket(uid)
    return apiUtils.sendApiSuccess(res, { suggestion: suggestion || null })
  } catch (e) {
    return apiUtils.sendApiError(res, 500, e.message)
  }
}

aiSuggestions.review = async (req, res) => {
  const id = req.params.id
  const payload = req.body || {}
  const accepted = _.intersection(Array.isArray(payload.acceptedFields) ? payload.acceptedFields : [], FIELD_KEYS)
  const usedDraft = payload.usedDraft === true

  try {
    const suggestion = await AISuggestion.findById(id)
    if (!suggestion) return apiUtils.sendApiError(res, 404, 'Suggestion not found')
    if (suggestion.status !== 'pending') return apiUtils.sendApiError(res, 409, `Suggestion is ${suggestion.status}`)

    const nothing = accepted.length === 0 && !usedDraft
    suggestion.status = nothing ? 'rejected' : 'approved'
    suggestion.acceptedFields = accepted
    suggestion.usedDraft = usedDraft
    suggestion.rejectReason = nothing ? str(payload.rejectReason || 'Bỏ qua', 500) : undefined
    suggestion.reviewedAt = new Date()
    suggestion.reviewedBy = req.user._id
    await suggestion.save()

    const ticket = await Ticket.findById(suggestion.ticket)
    if (ticket) {
      const parts = []
      if (accepted.length) parts.push('áp dụng ' + accepted.join(', '))
      if (usedDraft) parts.push('dùng nháp trả lời')
      ticket.history.push({
        action: 'ticket:ai:suggestion:' + suggestion.status,
        description: nothing ? 'Bỏ qua gợi ý AI' : 'Duyệt gợi ý AI: ' + parts.join('; '),
        owner: req.user._id
      })
      await ticket.save()
      emitUpdate(ticket)
    }

    return apiUtils.sendApiSuccess(res, { suggestion })
  } catch (e) {
    return apiUtils.sendApiError(res, 500, e.message)
  }
}

module.exports = aiSuggestions
module.exports.sanitize = sanitize
