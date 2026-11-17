/*
 * Các loại phản hồi tự động mà AI Agent gửi vào ticket. Dòng đầu của comment là nhãn chữ thuần
 * (không emoji) để trang web hiển thị tự nhiên; email nhận ra nhãn này và thay bằng icon
 * Material Design có sẵn trong Trudesk (xem icons.js).
 *
 * PHẢI KHỚP với ai-agent/src/autoreply/templates.js (MARKERS); có test kiểm tra.
 */

const KINDS = {
  answer: { label: 'Bộ phận IT · Trả lời tự động', icon: 'hardware-headset-mic', color: '#2b5ea7' },
  ack: { label: 'Bộ phận IT · Đã tiếp nhận yêu cầu', icon: 'action-assignment-turned-in', color: '#2b5ea7' },
  handoff: { label: 'Bộ phận IT · Đã chuyển nhân viên xử lý', icon: 'action-swap-horiz', color: '#b7791f' },
  closed: { label: 'Bộ phận IT · Đã đóng ticket', icon: 'action-check-circle', color: '#2f855a' }
}

/** Trả về { kind, ...KINDS[kind] } nếu dòng đầu văn bản là một nhãn tự động. */
function detectKind (text) {
  const first = String(text || '')
    .replace(/^\s+/, '')
    .split('\n')[0]
    .trim()
  for (const [kind, def] of Object.entries(KINDS)) if (first === def.label) return { kind, ...def }
  return null
}

module.exports = { KINDS, detectKind }
