/*
 * Ollama provider: gọi model chạy LOCAL qua Ollama (http://localhost:11434), không gửi dữ liệu ra ngoài.
 *
 * - Dùng /api/chat với `format` = JSON Schema của tác vụ -> Ollama ép đầu ra đúng cấu trúc.
 * - Model nhỏ hay lệch quy ước, nên chuẩn hóa trước khi guardrails kiểm tra:
 *     confidence 0-100 -> 0-1 ; citations "[KB-101] Tiêu đề" -> "KB-101"
 * - Model mặc định qwen2.5:7b-instruct (tiếng Việt tốt, theo JSON tốt). Đổi bằng OLLAMA_MODEL.
 */

const axios = require('axios')
const { LLMError } = require('../errors')

const REF_RE = /KB-\d+|#\d+/i

function normalize (value, key) {
  if (Array.isArray(value)) {
    if (key === 'citations') {
      return value
        .map(v => {
          const m = REF_RE.exec(String(v))
          return m ? m[0].toUpperCase() : null
        })
        .filter(Boolean)
    }
    return value.map(v => normalize(v))
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v, k)
    return out
  }
  if (key === 'confidence' && typeof value === 'number') {
    const v = value > 1 ? value / 100 : value
    return Math.max(0, Math.min(1, v))
  }
  return value
}

/**
 * Model 7B dễ rơi vào vòng lặp khi phải escape chuỗi nhiều dấu "\" trong JSON (vd đường dẫn UNC
 * \\fileserver\projects). Đổi "\\" thành "//" trong văn bản gửi model; nghĩa vẫn giữ nguyên.
 */
function sanitizeForModel (text) {
  return String(text || '').replace(/\\{2,}/g, '//')
}

class OllamaProvider {
  constructor ({ baseUrl = 'http://localhost:11434', model = 'qwen2.5:7b-instruct', timeoutMs = 180000, numPredict = 1024, numCtx = 4096, http } = {}) {
    this.name = 'ollama'
    this.model = model
    this.numPredict = numPredict
    this.numCtx = numCtx
    this.http = http || axios.create({ baseURL: baseUrl.replace(/\/$/, ''), timeout: timeoutMs })
  }

  async complete ({ system, prompt, schema }, attempt = 1) {
    let res
    try {
      res = await this.http.post('/api/chat', {
        model: this.model,
        stream: false,
        format: schema,
        keep_alive: '15m',
        // num_predict chặn trường hợp model sinh lặp không dừng; lần thử lại đổi seed.
        // num_ctx 4096: đủ cho prompt (< 2000 token). 8192 làm KV cache tràn VRAM 4 GB -> chậm ~20 lần.
        options: { temperature: 0.1, seed: 41 + attempt, num_ctx: this.numCtx, num_predict: this.numPredict },
        messages: [
          { role: 'system', content: sanitizeForModel(system) },
          { role: 'user', content: sanitizeForModel(prompt) }
        ]
      })
    } catch (err) {
      if (err.response && err.response.status === 404) {
        throw new LLMError(`model "${this.model}" chưa có trong Ollama (ollama list)`, { kind: 'bad_request' })
      }
      const network = !err.response || err.code === 'ECONNREFUSED' || err.code === 'ECONNABORTED'
      throw new LLMError(`ollama: ${err.message}`, { retryable: network, kind: network ? 'network' : 'server' })
    }

    const content = res.data && res.data.message ? res.data.message.content : ''
    let json
    try {
      json = JSON.parse(content)
    } catch (e) {
      if (attempt < 2) return this.complete({ system, prompt, schema }, attempt + 1)
      throw new LLMError('invalid JSON from model', { kind: 'invalid_json' })
    }

    return {
      json: normalize(json),
      usage: { input_tokens: res.data.prompt_eval_count || 0, output_tokens: res.data.eval_count || 0 },
      model: this.model
    }
  }
}

module.exports = { OllamaProvider, normalize, sanitizeForModel }
