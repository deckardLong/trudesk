/*
 * Mock LLM provider: chạy offline, tất định, KHÔNG gọi mạng.
 * Mô phỏng hành vi của LLM bằng luật từ khóa + ngữ cảnh RAG, để demo và test toàn bộ pipeline
 * (che PII, guardrails, duyệt gợi ý, audit) mà không cần API key.
 *
 * Provider nhận `input` có cấu trúc (mock dùng), còn `system`/`prompt` dành cho LLM thật.
 */

const catalog = require('../../../mock-data/catalog.json')
const { stripHtml } = require('../../rag/text')

function hasWord (text, phrase) {
  const escaped = phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(text)
}

function hits (text, keywords) {
  return keywords.filter(k => hasWord(text, k))
}

const clamp = (x, lo = 0, hi = 0.97) => Math.max(lo, Math.min(hi, Math.round(x * 100) / 100))

function triage ({ text, similar = [] }, cat = catalog) {
  const t = String(text).normalize('NFC').toLowerCase()

  // Group: nhiều từ khóa khớp nhất; ticket cũ tương tự cùng nhóm thì tăng độ tin cậy.
  const groupScores = cat.groups.map(g => ({ name: g.name, hits: hits(t, g.keywords) }))
  groupScores.sort((a, b) => b.hits.length - a.hits.length)
  const best = groupScores[0]
  const margin = best.hits.length - (groupScores[1] ? groupScores[1].hits.length : 0)
  let groupConf = best.hits.length === 0 ? 0.3 : 0.5 + 0.1 * best.hits.length + 0.05 * margin
  const neighbor = similar.find(s => s.labels && s.score >= 0.3)
  if (neighbor && neighbor.labels.group === best.name) groupConf += 0.08

  // Type: luật theo thứ tự ưu tiên Problem > Change > Service Request > Incident.
  let type = { value: 'Incident', confidence: 0.45, hits: [] }
  for (const rule of cat.typeRules) {
    const h = hits(t, rule.keywords)
    if (h.length) {
      type = { value: rule.type, confidence: 0.62 + 0.1 * h.length, hits: h }
      break
    }
  }

  // Priority: Critical > Low > High; không có dấu hiệu -> Normal.
  let priority = { value: 'Normal', confidence: 0.72, hits: [] }
  for (const rule of cat.priorityRules) {
    const h = hits(t, rule.keywords)
    if (h.length) {
      priority = { value: rule.priority, confidence: 0.7 + 0.08 * h.length, hits: h }
      break
    }
  }

  const tags = Object.entries(cat.tagRules || {})
    .filter(([, kws]) => hits(t, kws).length > 0)
    .map(([tag]) => tag)

  return {
    type: { value: type.value, confidence: clamp(type.confidence) },
    priority: { value: priority.value, confidence: clamp(priority.confidence) },
    group: { value: best.name, confidence: clamp(groupConf) },
    tags: { value: tags, confidence: tags.length ? 0.85 : 0.4 },
    rationale:
      `group: ${best.hits.join(', ') || 'không rõ'}; type: ${type.hits.join(', ') || 'mặc định'}; ` +
      `priority: ${priority.hits.join(', ') || 'mặc định'}` +
      (neighbor ? `; tương tự ${neighbor.refId}` : '')
  }
}

function replyDraft ({ contexts = [] }) {
  if (contexts.length === 0) {
    return {
      draft: 'Chào anh/chị, IT đã nhận yêu cầu. Anh/chị vui lòng bổ sung ảnh chụp màn hình lỗi để IT hỗ trợ nhanh hơn.',
      citations: [],
      confidence: 0.4
    }
  }

  const kb = contexts.find(c => c.source === 'kb')
  const past = contexts.find(c => c.source === 'ticket')
  const lines = ['Chào anh/chị,', '', 'Cảm ơn anh/chị đã báo cho IT.']
  const citations = []

  if (kb) {
    const steps = kb.text.split('\n').filter(l => /^Bước \d/.test(l.trim()))
    lines.push(`Theo hướng dẫn "${kb.title}" [${kb.refId}], anh/chị thử lần lượt:`)
    lines.push(...(steps.length ? steps : [kb.text.split('\n')[0]]).map(s => `- ${s.trim()}`))
    citations.push(kb.refId)
  }
  if (past) {
    // Chỉ nêu nguyên nhân của ca cũ, không chép hành động "Đã ..." (người đọc dễ hiểu nhầm là đã làm cho mình).
    const resolution = (past.text.split('Cách giải quyết:')[1] || '').trim()
    const cause = firstSentence(resolution)
    if (cause && !/^\s*(đã|vừa)\s/i.test(cause)) {
      lines.push('', `Ở một trường hợp tương tự (${past.refId}), nguyên nhân là: ${cause}`)
      citations.push(past.refId)
    }
  }
  lines.push('', 'Nếu vẫn chưa được, anh/chị trả lời lại ticket này để IT hỗ trợ tiếp nhé.')

  const top = contexts[0].score || 0
  return { draft: lines.join('\n'), citations, confidence: clamp(0.55 + top * 0.6, 0, 0.92) }
}

function dedupVerify ({ candidates = [], thresholds }) {
  return {
    verdicts: candidates.map(c => {
      const relation =
        c.score >= thresholds.duplicateThreshold ? 'duplicate' : c.score >= thresholds.similarThreshold ? 'related' : 'unrelated'
      return { ref: c.refId, relation, confidence: clamp(0.6 + c.score * 0.6) }
    })
  }
}

function firstSentence (s) {
  const text = stripHtml(s)
  const m = text.match(/^(.+?[.!?])(\s|$)/)
  return (m ? m[1] : text).slice(0, 200)
}

function summarize ({ thread }) {
  const comments = thread.comments || []
  const last = comments[comments.length - 1]
  const parts = [`Vấn đề: ${firstSentence(thread.issue)}`, `Đã có ${comments.length} lượt trao đổi.`]
  if (last) parts.push(`Mới nhất (${last.author}): ${firstSentence(last.text)}`)
  return { summary: parts.join(' '), confidence: 0.8 }
}

function followUp ({ text }) {
  const t = String(text || '').normalize('NFC').toLowerCase()
  if (hits(t, ['nhân viên', 'gặp người', 'gọi điện', 'gọi cho em', 'gọi cho tôi', 'người thật']).length) {
    return { label: 'wants_human', confidence: 0.9 }
  }
  const negative = hits(t, ['vẫn', 'chưa được', 'không được', 'vẫn lỗi', 'không hiệu quả', 'không vào được']).length
  const positive = hits(t, ['được rồi', 'đã được', 'ok rồi', 'đã vào được', 'hết lỗi', 'giải quyết được', 'cảm ơn']).length
  if (negative && !hits(t, ['được rồi', 'đã được']).length) return { label: 'not_resolved', confidence: 0.85 }
  if (positive) return { label: 'resolved', confidence: 0.88 }
  return { label: 'other', confidence: 0.6 }
}

const TASKS = { triage, reply_draft: replyDraft, dedup_verify: dedupVerify, summarize, follow_up: followUp }

class MockProvider {
  constructor () {
    this.name = 'mock'
    this.model = 'mock-rules-v1'
  }

  async complete ({ task, input, system = '', prompt = '' }) {
    const fn = TASKS[task]
    if (!fn) throw new Error(`MockProvider: unknown task ${task}`)
    const json = fn(input || {})
    const inputTokens = Math.ceil((system.length + prompt.length) / 4)
    const outputTokens = Math.ceil(JSON.stringify(json).length / 4)
    return { json, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, model: this.model }
  }
}

module.exports = { MockProvider, triage, replyDraft }
