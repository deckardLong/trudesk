/*
 * Pre-processor (sơ đồ 3): che thông tin cá nhân TRƯỚC khi văn bản rời khỏi service (tới LLM, tới ES).
 *
 * Thay giá trị bằng nhãn có đánh số: "0912345678" -> "[PHONE_1]".
 * Bảng ánh xạ (vault) chỉ nằm trong bộ nhớ của job, KHÔNG gửi đi đâu;
 * dùng unmask() để khôi phục trong nháp trả lời trước khi đưa cho agent duyệt.
 */

const RULES = [
  // Thứ tự quan trọng: mẫu dài/đặc thù trước.
  { label: 'SECRET', re: /\b(mật khẩu|mat khau|password|pass|pwd)\s*[:=]\s*\S+/gi, keepPrefix: true },
  { label: 'EMAIL', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi },
  { label: 'CARD', re: /\b(?:\d[ -]?){13,16}\b/g },
  { label: 'NATIONAL_ID', re: /\b\d{12}\b/g },
  { label: 'PHONE', re: /(?:\+84|\b0)(?:[\s.-]?\d){9}\b/g },
  { label: 'IP', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g }
]

function mask (text) {
  const vault = {}
  const counters = {}
  let out = String(text || '')

  for (const rule of RULES) {
    out = out.replace(rule.re, (match, prefix) => {
      counters[rule.label] = (counters[rule.label] || 0) + 1
      const tag = `[${rule.label}_${counters[rule.label]}]`
      vault[tag] = match
      return rule.keepPrefix ? `${prefix}: ${tag}` : tag
    })
  }

  return { text: out, vault, found: counters }
}

/** Khôi phục giá trị gốc. Không bao giờ khôi phục SECRET (mật khẩu) vào nháp. */
function unmask (text, vault) {
  return String(text || '').replace(/\[([A-Z_]+)_(\d+)\]/g, (tag, label) => {
    if (label === 'SECRET') return '[đã ẩn]'
    return vault && vault[tag] !== undefined ? vault[tag] : tag
  })
}

/**
 * Bỏ hẳn nhãn PII (không khôi phục được). Dùng cho:
 *  - kho tri thức: PII của người cũ vô dụng, và nhãn [PHONE_1] của họ sẽ trùng tên nhãn của ticket mới;
 *  - đầu vào soạn nháp: model không cần SĐT/email để hướng dẫn sửa lỗi.
 */
function dropTags (text) {
  return String(text || '')
    .replace(/(mật khẩu|mat khau|password|pass|pwd)\s*:\s*\[SECRET_\d+\]/gi, '')
    .replace(/[^\n.]*\[(EMAIL|PHONE|CARD|NATIONAL_ID|IP|SECRET)_\d+\][^\n.]*\.?/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

module.exports = { mask, unmask, dropTags }
