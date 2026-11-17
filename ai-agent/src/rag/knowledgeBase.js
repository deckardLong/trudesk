/*
 * RAG (sơ đồ 4): nhánh NẠP tri thức + nhánh TRUY VẤN.
 *
 * Nạp (chạy theo lịch): ticket đã đóng + bài KB Published -> làm sạch + che PII -> chia đoạn -> embedding -> kho vector
 * Truy vấn (mỗi ticket): ticket mới -> embedding -> top-k -> trả đoạn tri thức kèm nguồn
 */

const { mask, dropTags } = require('../preprocess/piiMasker')
const { stripHtml } = require('./text')

function chunk (text, size) {
  const paragraphs = String(text).split(/\n\s*\n|\n/).map(p => p.trim()).filter(Boolean)
  const chunks = []
  let current = ''
  for (const p of paragraphs) {
    if (current && (current + '\n' + p).length > size) {
      chunks.push(current)
      current = p
    } else {
      current = current ? current + '\n' + p : p
    }
  }
  if (current) chunks.push(current)
  return chunks
}

class KnowledgeBase {
  constructor ({ embedder, store, chunkSize = 600 }) {
    this.embedder = embedder
    this.store = store
    this.chunkSize = chunkSize
  }

  /** Chỉ bài Published mới được nạp (quy tắc KB của người A). */
  ingestArticles (articles) {
    let n = 0
    for (const a of articles) {
      if (a.status !== 'Published') continue
      const clean = dropTags(mask(stripHtml(a.body)).text)
      chunk(clean, this.chunkSize).forEach((text, i) => {
        this.store.upsert([
          {
            id: `${a.id}#${i}`,
            source: 'kb',
            refId: a.id,
            title: a.title,
            text,
            embedding: this.embedder.embed(`${a.title}\n${text}`)
          }
        ])
        n++
      })
    }
    return n
  }

  /** Ticket đã đóng: dùng cả câu hỏi và cách giải quyết làm tri thức. */
  ingestClosedTickets (tickets) {
    let n = 0
    for (const t of tickets) {
      const text = dropTags(mask(stripHtml(`${t.issue}\nCách giải quyết: ${t.resolution}`)).text)
      this.store.upsert([
        {
          id: `T-${t.uid}`,
          source: 'ticket',
          refId: `#${t.uid}`,
          title: t.subject,
          text,
          labels: { type: t.type, priority: t.priority, group: t.group },
          embedding: this.embedder.embed(`${t.subject}\n${text}`)
        }
      ])
      n++
    }
    return n
  }

  search (query, { k = 3, minScore = 0, source } = {}) {
    const vector = this.embedder.embed(query)
    return this.store
      .knn(vector, { k, filter: source ? d => d.source === source : null })
      .filter(r => r.score >= minScore)
  }
}

module.exports = { KnowledgeBase, chunk }
