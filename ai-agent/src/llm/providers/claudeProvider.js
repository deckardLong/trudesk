/*
 * Claude provider: gọi Claude API qua SDK chính thức @anthropic-ai/sdk.
 *
 * - Structured outputs (output_config.format = json_schema) ép đúng schema của tác vụ.
 * - effort theo tác vụ: phân loại/tóm tắt dùng 'low', soạn nháp dùng 'medium'.
 * - Server-side fallback ('default') khi model từ chối vì bộ lọc an toàn; vẫn kiểm tra stop_reason.
 * - SDK chỉ được nạp khi AI_PROVIDER=claude, nên chế độ mock không cần cài SDK.
 *
 * Yêu cầu: Node >= 18, `npm install` trong ai-agent/, và ANTHROPIC_API_KEY (hoặc `ant auth login`).
 */

const { LLMError } = require('../errors')

const EFFORT = { triage: 'low', dedup_verify: 'low', summarize: 'low', reply_draft: 'medium' }

class ClaudeProvider {
  constructor ({ model = 'claude-opus-5-5', client } = {}) {
    this.name = 'claude'
    this.model = model
    if (client) {
      this.client = client
      this.Anthropic = null
    } else {
      const mod = require('@anthropic-ai/sdk')
      this.Anthropic = mod.default || mod
      this.client = new this.Anthropic()
    }
  }

  async complete ({ task, system, prompt, schema }) {
    let response
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        messages: [{ role: 'user', content: prompt }],
        output_config: {
          effort: EFFORT[task] || 'low',
          format: { type: 'json_schema', schema }
        }
      })
    } catch (err) {
      throw this.wrapError(err)
    }

    if (response.stop_reason === 'refusal') {
      const category = response.stop_details && response.stop_details.category
      throw new LLMError(`refusal (${category || 'unknown'})`, { kind: 'refusal' })
    }
    if (response.stop_reason === 'max_tokens') {
      throw new LLMError('output truncated at max_tokens', { kind: 'truncated' })
    }

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')

    let json
    try {
      json = JSON.parse(text)
    } catch (e) {
      throw new LLMError('invalid JSON from model', { kind: 'invalid_json' })
    }

    return { json, usage: response.usage, model: response.model }
  }

  wrapError (err) {
    const A = this.Anthropic
    if (A && err instanceof A.RateLimitError) return new LLMError('rate limited', { retryable: true, kind: 'rate_limit' })
    if (A && err instanceof A.AuthenticationError) return new LLMError('invalid API credentials', { kind: 'auth' })
    if (A && err instanceof A.BadRequestError) return new LLMError('bad request: ' + err.message, { kind: 'bad_request' })
    if (A && err instanceof A.APIConnectionError) return new LLMError('connection error', { retryable: true, kind: 'network' })
    if (A && err instanceof A.APIError && err.status >= 500) {
      return new LLMError(`server error ${err.status}`, { retryable: true, kind: 'server' })
    }
    return new LLMError(err && err.message ? err.message : String(err))
  }
}

module.exports = { ClaudeProvider, LLMError }
