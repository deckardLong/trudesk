#!/usr/bin/env node
/*
 * DEMO: TỰ ĐỘNG TRẢ LỜI EMAIL bằng model LOCAL trong Ollama (mặc định qwen2.5:7b-instruct).
 *
 *   1. Người dùng gửi ticket (web hoặc email)
 *   2. AI (Ollama) triage + tìm KB + soạn trả lời -> qua cổng kiểm tra -> TỰ GỬI email cho người dùng
 *      (không qua cổng -> gửi email xác nhận tiếp nhận, chuyển nhân viên)
 *   3. Người dùng trả lời email -> AI hiểu ý: "được rồi" -> đóng ticket ; "vẫn lỗi / gặp nhân viên" -> chuyển người
 *
 * Chạy:   node demo/e2e-auto-reply-ollama.js            (cần Ollama đang chạy)
 *         node demo/e2e-auto-reply-ollama.js --mock     (không cần Ollama)
 *         OLLAMA_MODEL=llama3.1:latest node demo/e2e-auto-reply-ollama.js
 * Email ghi ra logs/mock-mailbox/*.eml
 */

const fs = require('fs')
const path = require('path')
const axios = require('axios')
const nodemailer = require('nodemailer')

const { createAgent, makeEvent } = require('../ai-agent/src/bootstrap')
const { load } = require('../ai-agent/src/config')
const { MockCore } = require('../ai-agent/src/core/mockCore')
const { createTicketReplyNotifier } = require('../src/notifications/ticketReply')
const { resolveInboundReply } = require('../src/notifications/ticketReply/inboundReply')
const { createMockDeps } = require('./ticket-reply/mockDeps')
const helpdesk = require('./mock-data/helpdesk')
const incoming = require('../ai-agent/mock-data/incoming-tickets.json')

const MAILBOX_DIR = path.resolve(__dirname, '..', 'logs', 'mock-mailbox')
const c = { dim: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, m: s => `\x1b[35m${s}\x1b[0m` }
const step = s => console.log(`\n${c.b(c.m('== ' + s))}`)
const indent = (s, n = 6) => s.split('\n').map(l => ' '.repeat(n) + l).join('\n')

// Ticket trong demo: ai gửi, gửi qua kênh nào
const SCENARIO = [
  { uid: 1042, owner: 'u-user-hoa', via: 'web' },
  { uid: 1043, owner: 'u-user-tuan', via: 'email' }, // người ngoài, chỉ có email
  { uid: 1046, owner: 'u-user-khoa', via: 'web' },
  { uid: 1047, owner: 'u-user-hoa', via: 'web' } // Critical -> phải có người
]
// Người dùng trả lời email sau khi nhận câu trả lời tự động
const REPLIES = [
  { uid: 1042, from: 'hoa.le@acme.vn', text: 'Em làm theo bước 2 rồi khởi động lại thì vào được VPN rồi ạ. Cảm ơn anh nhiều!' },
  { uid: 1046, from: 'khoa.vo@acme.vn', text: 'Tôi đã tắt Work Offline và tạo lại profile nhưng thư vẫn kẹt trong Outbox, cho tôi gặp nhân viên được không?' }
]

async function ollamaReady (cfg) {
  try {
    const res = await axios.get(cfg.baseUrl + '/api/tags', { timeout: 3000 })
    return (res.data.models || []).some(m => m.name === cfg.model)
  } catch (e) {
    return false
  }
}

async function main () {
  const forceMock = process.argv.indexOf('--mock') !== -1
  let config = load({ ...process.env, AI_PROVIDER: 'ollama' })
  if (forceMock || !(await ollamaReady(config.ollama))) {
    if (!forceMock) console.log(c.y(`Không thấy Ollama/model ${config.ollama.model} ở ${config.ollama.baseUrl} -> dùng provider mock.`))
    config = load({ ...process.env, AI_PROVIDER: 'mock' })
  }

  fs.mkdirSync(MAILBOX_DIR, { recursive: true })
  const eml = nodemailer.createTransport({ streamTransport: true, buffer: true })
  const h = createMockDeps({ online: ['u-agent-minh'] }) // người dùng đều offline -> nhận email
  const realSend = h.deps.sendEmail
  h.deps.sendEmail = async message => {
    const info = await eml.sendMail({ from: '"IT Helpdesk" <support@acme.vn>', ...message })
    message.file = path.join(MAILBOX_DIR, `${h.state.clock}-${message.to.replace(/[^a-z0-9@.]/gi, '_')}.eml`)
    fs.writeFileSync(message.file, info.message)
    return realSend(message)
  }
  const notifier = createTicketReplyNotifier(h.deps)
  const core = new MockCore({ now: h.deps.now })
  const agent = createAgent({ config, core, now: h.deps.now })
  const users = helpdesk.userMap()
  const pending = []
  core.on('ticket:comment:added', ({ ticket, comment }) => pending.push(notifier.onCommentAdded({ ticket, comment })))

  async function deliverEmails () {
    await Promise.all(pending.splice(0))
    h.advance(61 * 1000)
    const before = h.state.sentEmails.length
    await notifier.flush()
    return h.state.sentEmails.slice(before)
  }
  function printEmail (mail, full) {
    console.log(`   ${c.g('email')} -> ${mail.to}  ${c.dim(path.basename(mail.file))}`)
    console.log(`      Subject: ${mail.subject}`)
    const body = mail.text.split('\n').slice(2).join('\n').split('\nXem ticket:')[0].trim()
    console.log(c.dim(indent(full ? body : body.split('\n').slice(0, 6).join('\n') + '\n...')))
  }

  console.log(c.b(`Provider: ${agent.llm.provider.name} / ${agent.llm.provider.model}`))

  // ---- 1-2. Ticket mới -> AI tự trả lời
  for (const s of SCENARIO) {
    const t = incoming.find(x => x.uid === s.uid)
    const owner = users.get(s.owner)
    core.addTicket({ _id: `t-${t.uid}`, uid: t.uid, subject: t.subject, issue: t.issue, status: helpdesk.statuses.open, owner: s.owner, assignee: 'u-agent-minh', subscribers: [s.owner, 'u-agent-minh'], group: t.expected.group })

    step(`#${t.uid} "${t.subject}" - ${owner.fullname} gửi qua ${s.via}`)
    const started = Date.now()
    const res = await agent.pipeline.handle(makeEvent('ticket.created', t, `evt-${t.uid}`))
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    if (res.status === 'skipped') {
      console.log(c.r(`   AI lỗi (${res.reason}): ${res.message} -> ticket vẫn bình thường, chờ nhân viên`))
      continue
    }
    const f = res.suggestion.fields
    console.log(`   AI (${secs}s): ${f.type.value} / ${f.priority.value} / ${f.group.value}  nguồn: ${res.suggestion.replyDraft.citations.join(', ') || '—'}`)
    for (const ck of res.autoReply.checks) console.log(`     ${ck.ok ? c.g('[OK]') : c.r('[--]')} ${ck.name.padEnd(17)} ${c.dim(ck.detail || '')}`)
    const label = res.autoReply.kind === 'answer' ? c.g('TỰ ĐỘNG TRẢ LỜI') : c.y('chỉ xác nhận tiếp nhận + chuyển nhân viên')
    console.log(`   -> ${label}; trạng thái ticket: ${(await core.getTicket(t.uid)).status.name}`)
    for (const mail of await deliverEmails()) printEmail(mail, res.autoReply.kind === 'answer' && s.uid === 1042)
  }

  // ---- 3. Người dùng trả lời email
  const findTicketByUid = async uid => {
    const t = await core.getTicket(uid)
    if (!t) return null
    const pop = id => ({ _id: id, email: users.get(id).email })
    return { ...t, owner: pop(t.owner), assignee: pop(t.assignee), subscribers: t.subscribers.map(pop) }
  }
  for (const r of REPLIES) {
    const mailToUser = h.state.sentEmails.find(m => m.subject.indexOf(`#${r.uid}]`) !== -1)
    if (!mailToUser) continue
    step(`${r.from} trả lời email của ticket #${r.uid}`)
    console.log(c.dim(indent(`"${r.text}"`, 3)))
    const decision = await resolveInboundReply(
      { from: r.from, to: [mailToUser.replyTo], text: `${r.text}\n\nVào 09:00, IT Helpdesk đã viết:\n> ...` },
      { secret: h.state.settings.replySecret, findTicketByUid, now: h.deps.now }
    )
    console.log(`   IMAP -> ${decision.action} (token hợp lệ, người gửi là chủ ticket)`)
    await core.addUserComment(r.uid, decision.senderId, decision.body)
    await Promise.all(pending.splice(0))

    const started = Date.now()
    const res = await agent.pipeline.handle(core.toUpdatedEvent(r.uid))
    const t = await core.getTicket(r.uid)
    if (!res.label) {
      console.log(`   AI không can thiệp (${res.status}: ticket chưa có câu trả lời tự động) -> nhân viên xử lý; trạng thái: ${t.status.name}`)
    } else {
      console.log(`   AI hiểu là: ${c.b(res.label)} (${res.confidence}, ${((Date.now() - started) / 1000).toFixed(1)}s) -> ${res.status === 'closed' ? c.g('đóng ticket') : c.y('chuyển nhân viên, AI dừng')}; trạng thái: ${t.status.name}`)
    }
    if (t.notes && t.notes.length) console.log(c.dim(indent('note nội bộ: ' + t.notes[t.notes.length - 1].note.replace(/<[^>]+>/g, ' ').trim(), 3)))
    for (const mail of await deliverEmails()) printEmail(mail, true)
  }

  step('Tổng kết')
  const calls = agent.audit.find({ kind: 'llm_call' })
  const totalMs = calls.reduce((s, e) => s + e.latencyMs, 0)
  console.log(`   ${calls.length} lần gọi ${agent.llm.provider.name}, tổng ${(totalMs / 1000).toFixed(0)}s; ${h.state.sentEmails.length} email gửi đi`)
  for (const m of h.state.sentEmails) console.log(`   ${m.file}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
