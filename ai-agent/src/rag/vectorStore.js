/*
 * Kho vector trong bộ nhớ, mô phỏng Elasticsearch 8 `dense_vector` + kNN.
 * Interface giữ giống ES để thay thế: upsert(docs), knn(vector, { k, filter }).
 *
 * Mapping ES tương ứng (tham khảo khi người C dựng index thật):
 *   { "mappings": { "properties": {
 *       "source": { "type": "keyword" }, "refId": { "type": "keyword" },
 *       "title": { "type": "text" }, "text": { "type": "text" },
 *       "embedding": { "type": "dense_vector", "dims": 512, "index": true, "similarity": "cosine" } } } }
 */

const { cosine } = require('./embedder')

class MemoryVectorStore {
  constructor ({ embedderId } = {}) {
    this.embedderId = embedderId
    this.docs = new Map()
  }

  upsert (docs) {
    for (const d of docs) this.docs.set(d.id, d)
  }

  knn (vector, { k = 3, filter } = {}) {
    const scored = []
    for (const d of this.docs.values()) {
      if (filter && !filter(d)) continue
      scored.push({ ...d, score: cosine(vector, d.embedding) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k).map(({ embedding, ...rest }) => rest)
  }

  size () {
    return this.docs.size
  }
}

module.exports = { MemoryVectorStore }
