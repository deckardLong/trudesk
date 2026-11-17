/*
 * Guardrails (sơ đồ 5) + quyết định duyệt (sơ đồ 6).
 *
 *   hạn mức chi phí -> định dạng JSON hợp lệ -> ngưỡng tin cậy -> chế độ tự ghi (mặc định TẮT)
 *
 * Quyết định cho từng trường gợi ý:
 *   'dropped' : confidence < confidenceThreshold                 (bỏ, chỉ ghi audit)
 *   'pending' : >= confidenceThreshold                            (chờ agent duyệt – Cách 1, mặc định)
 *   'auto'    : autoApply bật VÀ confidence >= autoApplyThreshold (Cách 3, chỉ bật khi đã đo chất lượng)
 */

const { validate } = require('../llm/schemas')

class BudgetExceeded extends Error {
  constructor (msg) {
    super(msg)
    this.kind = 'budget'
  }
}

class Budget {
  constructor ({ maxCallsPerHour, maxTokensPerDay }, now = () => Date.now()) {
    this.maxCallsPerHour = maxCallsPerHour
    this.maxTokensPerDay = maxTokensPerDay
    this.now = now
    this.calls = [] // timestamps
    this.tokens = [] // [timestamp, tokens]
  }

  prune () {
    const t = this.now()
    this.calls = this.calls.filter(ts => t - ts < 60 * 60 * 1000)
    this.tokens = this.tokens.filter(([ts]) => t - ts < 24 * 60 * 60 * 1000)
  }

  usedTokens () {
    return this.tokens.reduce((s, [, n]) => s + n, 0)
  }

  assertCanSpend (estimatedTokens) {
    this.prune()
    if (this.calls.length >= this.maxCallsPerHour) throw new BudgetExceeded('hourly call limit reached')
    if (this.usedTokens() + estimatedTokens > this.maxTokensPerDay) throw new BudgetExceeded('daily token budget reached')
  }

  record (tokens) {
    const t = this.now()
    this.calls.push(t)
    this.tokens.push([t, tokens])
  }
}

class InvalidOutput extends Error {
  constructor (errors) {
    super('invalid model output: ' + errors.slice(0, 3).join('; '))
    this.kind = 'invalid_output'
    this.errors = errors
  }
}

function assertValid (schema, json) {
  const errors = validate(schema, json)
  if (errors.length) throw new InvalidOutput(errors)
  return json
}

function decide (confidence, cfg) {
  if (confidence < cfg.confidenceThreshold) return 'dropped'
  if (cfg.autoApply && confidence >= cfg.autoApplyThreshold) return 'auto'
  return 'pending'
}

/** Áp quyết định cho từng trường triage. */
function decideTriageFields (triage, cfg) {
  const out = {}
  for (const key of ['type', 'priority', 'group', 'tags']) {
    const f = triage[key]
    const empty = Array.isArray(f.value) && f.value.length === 0
    out[key] = { value: f.value, confidence: f.confidence, decision: empty ? 'dropped' : decide(f.confidence, cfg) }
  }
  return out
}

module.exports = { Budget, BudgetExceeded, InvalidOutput, assertValid, decide, decideTriageFields }
