/*
 * Gợi ý của AI Agent cho một ticket (sơ đồ 6 trong docs/ai-agent-diagrams.md, Cách 1: agent duyệt khi xem ticket).
 *
 * AI ghi qua  POST /api/v1/tickets/:uid/ai-suggestions  (token của tài khoản ai.assistant)
 * Giao diện đọc/duyệt qua  GET /api/v2/tickets/:uid/ai-suggestions  và  PUT /api/v2/ai-suggestions/:id
 *
 * Việc áp dụng từng trường (type, priority, group) do giao diện thực hiện qua các socket event có sẵn
 * của Trudesk (TICKETS_TYPE_SET...), nên quyền và lịch sử ticket vẫn đi qua logic gốc; model này chỉ
 * lưu đề xuất và kết quả duyệt (ai duyệt, chọn trường nào, có dùng nháp không) để kiểm tra lại.
 */

const mongoose = require('mongoose')

const COLLECTION = 'aisuggestions'

// Sub-schema riêng: nếu viết thẳng `fields: { type: {...} }` Mongoose sẽ hiểu "type" là khai báo kiểu dữ liệu.
const FieldSchema = new mongoose.Schema(
  {
    value: mongoose.Schema.Types.Mixed,
    confidence: Number,
    decision: { type: String, enum: ['pending', 'auto', 'dropped'] }
  },
  { _id: false }
)

const aiSuggestionSchema = mongoose.Schema(
  {
    ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'tickets', required: true, index: true },
    ticketUid: { type: Number, required: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'expired'],
      default: 'pending',
      index: true
    },
    fields: {
      type: { type: FieldSchema },
      priority: { type: FieldSchema },
      group: { type: FieldSchema },
      tags: { type: FieldSchema }
    },
    // [{ ref: '#1042', relation: 'related', confidence: 0.75 }]
    similarTickets: [mongoose.Schema.Types.Mixed],
    replyDraft: {
      text: String,
      citations: [String],
      confidence: Number,
      decision: { type: String, enum: ['pending', 'dropped', 'auto_sent'] }
    },
    summary: {
      text: String,
      confidence: Number,
      decision: String
    },
    autoReply: {
      sent: Boolean,
      kind: String
    },
    rationale: String,
    model: String,
    expiresAt: { type: Date },

    reviewedAt: Date,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'accounts' },
    acceptedFields: [String],
    usedDraft: Boolean,
    rejectReason: String
  },
  { timestamps: true }
)

/** Gợi ý còn hiệu lực mới nhất của ticket; tự chuyển sang 'expired' nếu đã quá hạn. */
aiSuggestionSchema.statics.getActiveForTicket = async function (ticketUid) {
  const now = new Date()
  await this.model(COLLECTION).updateMany(
    { ticketUid, status: 'pending', expiresAt: { $lte: now } },
    { $set: { status: 'expired' } }
  )
  return this.model(COLLECTION)
    .findOne({ ticketUid, status: 'pending' })
    .sort({ createdAt: -1 })
    .populate('reviewedBy', 'username fullname')
}

module.exports = mongoose.model(COLLECTION, aiSuggestionSchema)
