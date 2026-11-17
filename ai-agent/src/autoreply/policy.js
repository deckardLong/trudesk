/*
 * Chính sách TỰ ĐỘNG TRẢ LỜI người dùng.
 *
 * AI chỉ được tự gửi khi qua HẾT các cổng dưới đây; trượt một cổng -> không gửi nháp,
 * thay vào đó gửi email xác nhận tiếp nhận và để nhân viên xử lý (nháp vẫn nằm chờ duyệt).
 *
 *   1. enabled            tính năng đang bật
 *   2. first-answer       AI chưa từng trả lời ticket này (tối đa 1 lần/ticket, tránh vòng lặp bot)
 *   3. type-allowed       loại ticket cho phép (mặc định Incident, Service Request; Problem/Change cần người)
 *   4. priority-allowed   không phải Critical (sự cố nghiêm trọng phải có người ngay)
 *   5. triage-confident   type và priority đều vượt ngưỡng (biết chắc đang xử lý loại việc gì)
 *   6. grounded           có trích nguồn thật và nguồn đó khớp đủ cao với ticket (không trả lời "chém")
 *   7. draft-confident    độ tin cậy của nháp >= ngưỡng
 *   8. safe-content       không đòi mật khẩu, không nhận đã làm việc mà AI không làm, không link lạ,
 *                         không còn nhãn PII, độ dài hợp lý
 *   9. single-user        ticket không nói tới ảnh hưởng nhiều người (luật cố định, không phụ thuộc model)
 */

// Câu ĐÒI người dùng đưa mật khẩu/OTP (không bắt câu mô tả như "nhập sai mật khẩu 5 lần").
const PASSWORD_REQUEST = /(gửi|cung cấp|cho (em|tôi|chúng tôi|mình|IT) biết|đọc cho|reply|trả lời kèm).{0,30}(mật khẩu|password|mã OTP|OTP)/i
const CLAIMED_ACTION = /(đã|vừa)\s+(cấp quyền|cấp lại|reset|đặt lại mật khẩu|mở khóa|khắc phục xong|xử lý xong|sửa xong|cài đặt xong|thay thế)/i
const LEFTOVER_PII = /\[(EMAIL|PHONE|CARD|NATIONAL_ID|IP|SECRET)_\d+\]|\[đã ẩn\]/
const URL_RE = /https?:\/\/[^\s)>\]"']+/gi
const WIDE_IMPACT = /(cả phòng|cả nhóm|cả công ty|toàn công ty|toàn bộ nhân viên|nhiều người|mọi người đều|tất cả (mọi người|nhân viên|máy))/i

function checkDraftSafety (text, contexts) {
  const problems = []
  const t = String(text || '')
  if (t.length < 60) problems.push('quá ngắn')
  if (t.length > 3000) problems.push('quá dài')
  if (PASSWORD_REQUEST.test(t)) problems.push('yêu cầu mật khẩu/OTP')
  const claimed = CLAIMED_ACTION.exec(t)
  if (claimed) problems.push(`tự nhận đã làm: "${claimed[0]}"`)
  if (LEFTOVER_PII.test(t)) problems.push('nhắc lại thông tin cá nhân (nhãn PII)')
  const contextText = contexts.map(c => c.text).join('\n')
  for (const url of t.match(URL_RE) || []) {
    const clean = url.replace(/[.,;]+$/, '')
    if (contextText.indexOf(clean) === -1) problems.push(`link không có trong tài liệu: ${clean}`)
  }
  return problems
}

/**
 * @param {Object} args
 * @param {Object} args.fields    kết quả triage sau guardrails { type, priority, ... } (value, confidence, decision)
 * @param {Array}  args.contexts  đoạn tri thức đã truy xuất (refId, score, text)
 * @param {Object} args.draft     { text, citations, confidence }
 * @param {Number} args.priorAiAnswers số lần AI đã trả lời ticket này
 * @param {Object} args.cfg       config.autoReply
 * @param {Number} args.confidenceThreshold ngưỡng triage chung
 * @returns {{ send: Boolean, checks: Array<{name, ok, detail}> }}
 */
function evaluateAutoReply ({ fields, contexts, draft, priorAiAnswers = 0, cfg, confidenceThreshold, ticketText = '' }) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail })

  add('enabled', cfg.enabled)
  add('first-answer', priorAiAnswers === 0, `đã trả lời ${priorAiAnswers} lần`)
  add('type-allowed', cfg.allowedTypes.indexOf(fields.type.value) !== -1, fields.type.value)
  add('priority-allowed', cfg.blockedPriorities.indexOf(fields.priority.value) === -1, fields.priority.value)
  add(
    'triage-confident',
    fields.type.confidence >= confidenceThreshold && fields.priority.confidence >= confidenceThreshold,
    `type ${fields.type.confidence}, priority ${fields.priority.confidence}`
  )

  const cited = contexts.filter(c => draft.citations.indexOf(c.refId) !== -1)
  const grounding = cited.length ? Math.max(...cited.map(c => c.score)) : 0
  add('grounded', cited.length > 0 && grounding >= cfg.minGroundingScore, `nguồn ${draft.citations.join(', ') || '—'}, điểm ${grounding.toFixed(2)}`)
  add('draft-confident', draft.confidence >= cfg.minConfidence, String(draft.confidence))

  const problems = checkDraftSafety(draft.text, contexts)
  add('safe-content', problems.length === 0, problems.join('; ') || 'ok')

  // Không dựa vào model: model 7B có thể gán nhầm sự cố diện rộng là Incident với độ tin cậy 0.95.
  const wide = WIDE_IMPACT.exec(String(ticketText || ''))
  add('single-user', !wide, wide ? `ảnh hưởng nhiều người: "${wide[0]}"` : 'ok')

  return { send: checks.every(c => c.ok), checks, grounding }
}

module.exports = { evaluateAutoReply, checkDraftSafety }
