/*
 * Embedding (sơ đồ 4).
 *
 * MockEmbedder: "hashing trick" trên unigram + bigram đã bỏ dấu, chuẩn hóa L2.
 *  - Chạy offline, tất định (cùng input -> cùng vector), đủ để demo tìm kiếm tương tự.
 *  - Khi thay bằng mô hình embedding thật, giữ nguyên interface embed(text) -> number[]
 *    và nhớ: nhánh nạp tri thức và nhánh truy vấn PHẢI dùng cùng một embedder.
 */

const { tokenize } = require('./text')

function hash (str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

class MockEmbedder {
  constructor ({ dims = 512 } = {}) {
    this.dims = dims
    this.id = `mock-hash-${dims}`
  }

  embed (text) {
    const v = new Array(this.dims).fill(0)
    const tokens = tokenize(text)
    const features = tokens.slice()
    for (let i = 0; i < tokens.length - 1; i++) features.push(tokens[i] + '_' + tokens[i + 1])

    for (const f of features) {
      const h = hash(f)
      const idx = h % this.dims
      v[idx] += (h & 1) === 0 ? 1 : -1
    }

    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map(x => x / norm)
  }
}

function cosine (a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

module.exports = { MockEmbedder, cosine }
