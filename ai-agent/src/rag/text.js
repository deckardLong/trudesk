/* Tiện ích xử lý văn bản tiếng Việt dùng chung cho embedding, triage giả lập. */

/** Bỏ thẻ HTML, gom khoảng trắng nhưng GIỮ xuống dòng (cần cho chia đoạn và tách các bước). */
function stripHtml (s) {
  return String(s || '')
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Bỏ dấu + chữ thường: "Không kết nối" -> "khong ket noi". */
function fold (s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
}

const STOPWORDS = new Set(
  'la va cua cho cac nhung mot duoc khi thi co toi em anh chi ban minh nay do de voi tu trong o ra vao nhe a a nhe da dang bi roi ma lai cung'.split(
    ' '
  )
)

function tokenize (s) {
  return fold(stripHtml(s))
    .replace(/\[[a-z_]+_\d+\]/g, ' ') // bỏ nhãn PII
    .split(/[^a-z0-9]+/)
    .filter(t => t && t.length > 1 && !STOPWORDS.has(t))
}

function containsPhrase (text, phrase) {
  return fold(text).indexOf(fold(phrase)) !== -1
}

module.exports = { stripHtml, fold, tokenize, containsPhrase }
