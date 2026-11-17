/*
 * Xác định AI nhận thông báo khi ticket có phản hồi mới.
 *
 * Quy tắc:
 *  1. Ứng viên: người tạo ticket (owner), người được giao (assignee), người theo dõi (subscribers).
 *  2. Không báo cho chính người viết phản hồi.
 *  3. Bỏ tài khoản đã xóa và bản trùng.
 *  4. Ghi chú nội bộ (internal note): chỉ nhân viên hỗ trợ nhận, người dùng cuối KHÔNG BAO GIỜ nhận.
 *
 * Hàm thuần: nhận dữ liệu, trả danh sách, không truy cập DB.
 */

function idOf (ref) {
  if (!ref) return null
  if (typeof ref === 'string') return ref
  if (ref._id) return String(ref._id)
  return String(ref)
}

/**
 * @param {Object}  args
 * @param {Object}  args.ticket       ticket (owner, assignee, subscribers có thể là id hoặc object)
 * @param {String}  args.authorId     id người viết phản hồi
 * @param {Boolean} args.isInternal   true nếu là internal note
 * @param {Map<String,Object>} args.users  id -> user đầy đủ { _id, email, deleted, isStaff, preferences }
 * @returns {Array<{user: Object, reason: String}>}
 */
function resolveRecipients ({ ticket, authorId, isInternal, users }) {
  const author = idOf(authorId)
  const candidates = []

  if (ticket.owner) candidates.push({ id: idOf(ticket.owner), reason: 'owner' })
  if (ticket.assignee) candidates.push({ id: idOf(ticket.assignee), reason: 'assignee' })
  for (const sub of ticket.subscribers || []) candidates.push({ id: idOf(sub), reason: 'subscriber' })

  const seen = new Set()
  const result = []

  for (const c of candidates) {
    if (!c.id || seen.has(c.id)) continue
    seen.add(c.id)

    if (c.id === author) continue

    const user = users.get(c.id)
    if (!user || user.deleted) continue
    if (isInternal && !user.isStaff) continue

    result.push({ user, reason: c.reason })
  }

  return result
}

module.exports = { resolveRecipients, idOf }
