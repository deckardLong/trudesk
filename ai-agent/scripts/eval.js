#!/usr/bin/env node
/*
 * Đo độ chính xác triage trên bộ ticket có nhãn (mock-data/incoming-tickets.json).
 *
 *   node ai-agent/scripts/eval.js                      # provider mock
 *   AI_PROVIDER=claude node ai-agent/scripts/eval.js   # Claude thật (tốn phí, cần API key)
 *   node ai-agent/scripts/eval.js --file path/to/labeled.json
 *
 * Báo cáo:
 *   accuracy : đúng / tổng
 *   coverage : tỉ lệ gợi ý vượt ngưỡng (được đưa cho agent)
 *   precision@shown : trong các gợi ý được đưa ra, bao nhiêu % đúng  <- số liệu quan trọng nhất cho niềm tin
 *
 * LƯU Ý: luật của provider mock được viết cùng lúc với bộ dữ liệu này, nên điểm mock gần như chắc chắn cao
 * và KHÔNG chứng minh gì về chất lượng thật. Dùng số của provider thật trên 30-50 ticket thật cho báo cáo.
 */

const path = require('path')
const { createAgent } = require('../src/bootstrap')
const skills = require('../src/skills')
const { decideTriageFields } = require('../src/guardrails/guardrails')
const { mask } = require('../src/preprocess/piiMasker')

const fileArg = process.argv.indexOf('--file')
const file = fileArg !== -1 ? path.resolve(process.argv[fileArg + 1]) : path.resolve(__dirname, '../mock-data/incoming-tickets.json')

async function main () {
  const data = require(file)
  const agent = createAgent()
  const FIELDS = ['type', 'priority', 'group']
  const stats = Object.fromEntries(FIELDS.map(f => [f, { correct: 0, shown: 0, shownCorrect: 0, errors: [] }]))
  let failed = 0

  for (const t of data) {
    const ticket = { uid: t.uid, subject: mask(t.subject).text, issue: mask(t.issue).text }
    const similar = agent.kb.search(`${ticket.subject}\n${ticket.issue}`, { k: 3, source: 'ticket' })
    let triage
    try {
      triage = await skills.triage(agent.llm, { ticket, similar, meta: { ticketUid: t.uid, eventId: 'eval' } })
    } catch (e) {
      failed++
      console.log(`#${t.uid} lỗi: ${e.message}`)
      continue
    }
    const fields = decideTriageFields(triage, agent.config.guardrails)
    for (const f of FIELDS) {
      const ok = fields[f].value === t.expected[f]
      const shown = fields[f].decision !== 'dropped'
      const s = stats[f]
      if (ok) s.correct++
      if (shown) s.shown++
      if (shown && ok) s.shownCorrect++
      if (!ok) s.errors.push(`#${t.uid}: ${fields[f].value} (${fields[f].confidence}) ≠ ${t.expected[f]}`)
    }
  }

  const n = data.length
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) + '%' : '—')
  console.log(`\nProvider: ${agent.llm.provider.name} (${agent.llm.provider.model}) | ${n} ticket | ngưỡng ${agent.config.guardrails.confidenceThreshold}\n`)
  console.log('| Trường   | Accuracy | Coverage | Precision@shown |')
  console.log('|----------|----------|----------|-----------------|')
  for (const f of FIELDS) {
    const s = stats[f]
    console.log(`| ${f.padEnd(8)} | ${pct(s.correct, n).padEnd(8)} | ${pct(s.shown, n).padEnd(8)} | ${pct(s.shownCorrect, s.shown).padEnd(15)} |`)
  }
  for (const f of FIELDS) for (const e of stats[f].errors) console.log(`  sai ${f}: ${e}`)
  if (failed) console.log(`\n${failed} ticket lỗi khi gọi LLM (đã bỏ qua).`)
  if (agent.llm.provider.name === 'mock') {
    console.log('\n(!) Provider mock dùng luật viết cho chính bộ dữ liệu này: số liệu chỉ để kiểm tra pipeline, không phải chất lượng thật.')
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
