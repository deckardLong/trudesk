/*
 * JSON Schema cho đầu ra của từng tác vụ.
 * Dùng 2 nơi: (1) gửi cho Claude qua structured outputs để ép đúng định dạng,
 *             (2) guardrails kiểm tra lại ở phía service (không tin đầu ra mù quáng).
 */

const catalog = require('../../mock-data/catalog.json')

const field = values => ({
  type: 'object',
  additionalProperties: false,
  required: ['value', 'confidence'],
  properties: {
    value: { type: 'string', enum: values },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  }
})

function triageSchema (cat = catalog) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'priority', 'group', 'tags', 'rationale'],
    properties: {
      type: field(cat.types),
      priority: field(cat.priorities),
      group: field(cat.groups.map(g => g.name)),
      tags: {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'confidence'],
        properties: {
          value: { type: 'array', items: { type: 'string', enum: cat.tags } },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        }
      },
      rationale: { type: 'string' }
    }
  }
}

const replyDraftSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['draft', 'citations', 'confidence'],
  properties: {
    draft: { type: 'string' },
    citations: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  }
}

const dedupSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'relation', 'confidence'],
        properties: {
          ref: { type: 'string' },
          relation: { type: 'string', enum: ['duplicate', 'related', 'unrelated'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        }
      }
    }
  }
}

const summarySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'confidence'],
  properties: {
    summary: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  }
}

const followUpSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'confidence'],
  properties: {
    label: { type: 'string', enum: ['resolved', 'not_resolved', 'wants_human', 'other'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  }
}

/** Bộ kiểm tra JSON Schema tối giản (đủ cho các schema ở trên). Trả về danh sách lỗi. */
function validate (schema, value, path = '$') {
  const errors = []
  const t = schema.type
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected object`]
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${path}.${k}: required`)
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && schema.properties[k]) errors.push(...validate(schema.properties[k], v, `${path}.${k}`))
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: not allowed`)
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected array`]
    value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}[${i}]`)))
  } else if (t === 'string') {
    if (typeof value !== 'string') return [`${path}: expected string`]
    if (schema.enum && schema.enum.indexOf(value) === -1) errors.push(`${path}: "${value}" not in enum`)
  } else if (t === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path}: expected number`]
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: < ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: > ${schema.maximum}`)
  }
  return errors
}

module.exports = { triageSchema, replyDraftSchema, dedupSchema, summarySchema, followUpSchema, validate }
