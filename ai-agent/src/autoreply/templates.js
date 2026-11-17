/*
 * Mẫu nội dung AI gửi cho người dùng. Mỗi mẫu bắt đầu bằng một dòng nhãn cố định (chữ thuần, không emoji) để:
 *  - người dùng biết đây là trả lời tự động (minh bạch),
 *  - pipeline nhận ra bình luận nào do AI viết khi đọc lại thread (đếm số lần trả lời, biết đã chuyển người),
 *  - email của Core thay nhãn bằng icon Material Design có sẵn trong Trudesk.
 * Nội dung là văn bản thuần/markdown; Core chuyển sang HTML và escape khi lưu comment.
 *
 * PHẢI KHỚP với src/notifications/ticketReply/autoReplyKinds.js (KINDS[*].label); có test kiểm tra.
 */

const MARKERS = {
  answer: 'Bộ phận IT · Trả lời tự động',
  ack: 'Bộ phận IT · Đã tiếp nhận yêu cầu',
  handoff: 'Bộ phận IT · Đã chuyển nhân viên xử lý',
  closed: 'Bộ phận IT · Đã đóng ticket'
}

function kindOf (text) {
  const t = String(text || '')
  for (const [kind, marker] of Object.entries(MARKERS)) if (t.indexOf(marker) !== -1) return kind
  return null
}

/**
 * Model nhỏ hay chèn siêu dữ liệu vào thân thư ("Confidence: High", "[Citation: KB-101]", "Note: ...").
 * Nguồn đã được ghi ở chân thư nên bỏ các dòng này.
 */
function cleanDraft (draft) {
  return String(draft || '')
    .split('\n')
    .filter(l => !/^\s*\[?\s*(citations?|confidence|nguồn tham khảo|độ tin cậy)\s*[:\]]/i.test(l))
    .filter(l => !/^\s*(note|ghi chú)\s*:/i.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function answer ({ draft, citations }) {
  return [
    MARKERS.answer,
    '',
    cleanDraft(draft),
    '',
    '---',
    `Đây là câu trả lời tự động dựa trên tài liệu nội bộ (${citations.join(', ')}).`,
    '- Nếu đã giải quyết được: trả lời "Đã được" để đóng ticket.',
    '- Nếu chưa được hoặc muốn gặp nhân viên: trả lời email này, nhân viên IT sẽ tiếp nhận ngay.'
  ].join('\n')
}

function acknowledgement ({ uid, group, priority }) {
  const team = group ? `nhóm ${group}` : 'bộ phận IT'
  return [
    MARKERS.ack,
    '',
    `IT đã nhận yêu cầu của anh/chị (ticket #${uid}) và chuyển cho ${team}.`,
    priority ? `Mức ưu tiên ban đầu: ${priority}.` : null,
    'Nhân viên sẽ phản hồi trong giờ làm việc. Anh/chị có thể trả lời email này để bổ sung thông tin (ảnh chụp lỗi, thời điểm xảy ra).'
  ]
    .filter(l => l !== null)
    .join('\n')
}

function handoff ({ group, reason }) {
  return [
    MARKERS.handoff,
    '',
    reason === 'wants_human'
      ? 'IT đã chuyển ticket cho nhân viên theo yêu cầu của anh/chị.'
      : 'Rất tiếc cách trên chưa giải quyết được. IT đã chuyển ticket cho nhân viên để hỗ trợ trực tiếp.',
    `Nhân viên ${group ? 'nhóm ' + group + ' ' : ''}sẽ liên hệ trong giờ làm việc; trợ lý AI sẽ không trả lời thêm ở ticket này.`
  ].join('\n')
}

function closed ({ uid }) {
  return [
    MARKERS.closed,
    '',
    `Cảm ơn anh/chị đã xác nhận. Ticket #${uid} đã được đóng.`,
    'Nếu sự cố quay lại trong 7 ngày, anh/chị chỉ cần trả lời email này để mở lại ticket.'
  ].join('\n')
}

/** Ghi chú nội bộ cho nhân viên khi AI bàn giao. */
function handoffNote ({ label, userText, aiCitations }) {
  return [
    `AI bàn giao ticket (người dùng phản hồi: ${label}).`,
    `Trước đó AI đã trả lời tự động theo: ${aiCitations.join(', ') || '—'}.`,
    `Người dùng viết: "${userText.slice(0, 500)}"`
  ].join('\n')
}

module.exports = { MARKERS, kindOf, cleanDraft, answer, acknowledgement, handoff, closed, handoffNote }
