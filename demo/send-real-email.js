#!/usr/bin/env node
/*
 * Gửi THẬT email trả lời tự động của AI qua SMTP Gmail.
 *
 * Chuẩn bị (một lần):
 *   1. Bật xác minh 2 bước cho tài khoản Google, tạo "Mật khẩu ứng dụng": https://myaccount.google.com/apppasswords
 *   2. Ghi vào ai-agent/.env (file đã nằm trong .gitignore):
 *        GMAIL_USER=tai.khoan@gmail.com
 *        GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
 *
 * Chạy:
 *   node demo/send-real-email.js --to nguoi.nhan@gmail.com                # ticket #1042 (VPN) -> AI tự trả lời
 *   node demo/send-real-email.js --to nguoi.nhan@gmail.com --ticket 1047  # Critical -> email xác nhận tiếp nhận
 *   node demo/send-real-email.js --to nguoi.nhan@gmail.com --dry-run      # chỉ soạn, ghi .eml, không gửi
 *   thêm --mock nếu không có Ollama
 *
 * Reply-To dùng plus-addressing của chính hộp Gmail gửi (tai.khoan+t1042.<sig>@gmail.com),
 * nên khi người nhận bấm Reply, thư quay về đúng hộp đó - sẵn sàng cho mailCheck (IMAP) đọc.
 */

const fs = require('fs')
const path = require('path')
const axios = require('axios')
const nodemailer = require('nodemailer')

const { createAgent, makeEvent } = require('../ai-agent/src/bootstrap')
const { load } = require('../ai-agent/src/config')
const { MockCore } = require('../ai-agent/src/core/mockCore')
const { createTicketReplyNotifier } = require('../src/notifications/ticketReply')
const { createMockDeps } = require('./ticket-reply/mockDeps')
const incoming = require('../ai-agent/mock-data/incoming-tickets.json')

function arg (name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i === -1) return def
  const v = process.argv[i + 1]
  return v && v.indexOf('--') !== 0 ? v : true
}

function loadDotEnv (file) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

async function ollamaReady (cfg) {
  try {
    const res = await axios.get(cfg.baseUrl + '/api/tags', { timeout: 3000 })
    return (res.data.models || []).some(m => m.name === cfg.model)
  } catch (e) {
    return false
  }
}

async function main () {
  loadDotEnv(path.resolve(__dirname, '..', 'ai-agent', '.env'))
  const to = arg('to')
  const uid = Number(arg('ticket', 1042))
  const dryRun = arg('dry-run', false) === true
  const user = process.env.GMAIL_USER
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '')

  if (!to || to === true || to.indexOf('@') === -1) throw new Error('Thiếu --to <email người nhận>')
  if (!dryRun && (!user || !pass)) throw new Error('Thiếu GMAIL_USER / GMAIL_APP_PASSWORD trong ai-agent/.env (xem đầu file này)')
  const ticketSrc = incoming.find(t => t.uid === uid)
  if (!ticketSrc) throw new Error(`Không có ticket #${uid} trong mock data`)

  // ---- Transport: Gmail SMTP thật (STARTTLS 587) hoặc dry-run
  const transport = dryRun
    ? nodemailer.createTransport({ streamTransport: true, buffer: true })
    : nodemailer.createTransport({ host: 'smtp.gmail.com', port: 587, secure: false, requireTLS: true, auth: { user, pass } })
  if (!dryRun) {
    await transport.verify()
    console.log(`SMTP Gmail: đăng nhập OK (${user})`)
  }

  // ---- Môi trường mock, người tạo ticket là người nhận thật
  const h = createMockDeps({ online: [] })
  const owner = h.deps
  const users = await owner.loadUsers(['u-user-hoa'])
  const requester = users.get('u-user-hoa')
  requester.email = to.toLowerCase()
  requester.fullname = arg('name', to.split('@')[0])
  const origLoad = h.deps.loadUsers
  h.deps.loadUsers = async ids => {
    const m = await origLoad(ids)
    if (m.has('u-user-hoa')) m.set('u-user-hoa', requester)
    return m
  }
  h.state.settings.mailbox = dryRun ? user || 'support@acme.vn' : user
  h.state.settings.siteUrl = 'http://localhost:8118'

  const sent = []
  h.deps.sendEmail = async message => {
    const info = await transport.sendMail({ from: `"IT Helpdesk (demo)" <${user || 'support@acme.vn'}>`, ...message })
    const dir = path.resolve(__dirname, '..', 'logs', 'mock-mailbox')
    fs.mkdirSync(dir, { recursive: true })
    if (info.message) fs.writeFileSync(path.join(dir, `dryrun-${uid}.eml`), info.message)
    sent.push({ message, info })
    return info
  }

  let config = load({ ...process.env, AI_PROVIDER: 'ollama' })
  if (arg('mock', false) === true || !(await ollamaReady(config.ollama))) {
    console.log('Không dùng Ollama -> provider mock')
    config = load({ ...process.env, AI_PROVIDER: 'mock' })
  }

  const notifier = createTicketReplyNotifier(h.deps)
  const core = new MockCore({ now: h.deps.now })
  const agent = createAgent({ config, core, now: h.deps.now })
  const jobs = []
  core.on('ticket:comment:added', ({ ticket, comment }) => jobs.push(notifier.onCommentAdded({ ticket, comment })))
  core.addTicket({
    _id: `t-${uid}`,
    uid,
    subject: ticketSrc.subject,
    issue: ticketSrc.issue,
    status: { name: 'Open', isResolved: false },
    owner: 'u-user-hoa',
    assignee: 'u-agent-minh',
    subscribers: ['u-user-hoa', 'u-agent-minh'],
    group: ticketSrc.expected.group
  })

  console.log(`Ticket #${uid}: "${ticketSrc.subject}" - AI (${agent.llm.provider.name}) đang xử lý...`)
  const res = await agent.pipeline.handle(makeEvent('ticket.created', ticketSrc, `real-${uid}-${Date.now()}`))
  if (res.status === 'skipped') throw new Error(`AI lỗi: ${res.message}`)
  for (const ck of res.autoReply.checks) console.log(`  ${ck.ok ? '[OK]' : '[--]'} ${ck.name.padEnd(17)} ${ck.detail || ''}`)
  console.log(`-> ${res.autoReply.kind === 'answer' ? 'TỰ ĐỘNG TRẢ LỜI' : 'xác nhận tiếp nhận + chuyển nhân viên'}`)

  await Promise.all(jobs)
  h.advance(61 * 1000) // hết thời gian gộp email
  await notifier.flush()

  const failed = notifier.outbox.store.history.filter(j => j.status === 'failed').concat(notifier.outbox.pending())
  for (const j of failed) console.log(`[--] chưa gửi được tới ${j.recipient.email}: ${j.lastError}`)
  const mine = sent.filter(s => s.message.to === requester.email)
  for (const s of mine) {
    console.log(`\n${dryRun ? '(dry-run) đã soạn' : 'ĐÃ GỬI'} -> ${s.message.to}`)
    console.log(`  Subject:  ${s.message.subject}`)
    console.log(`  Reply-To: ${s.message.replyTo}`)
    if (!dryRun) console.log(`  SMTP:     ${s.info.response} | accepted: ${s.info.accepted.join(', ')}`)
    else console.log('  File:     logs/mock-mailbox/dryrun-' + uid + '.eml')
  }
  if (!mine.length) process.exitCode = 1
}

main().catch(err => {
  console.error('Lỗi:', err.message)
  if (/Invalid login|535/.test(err.message)) console.error('-> Gmail từ chối: cần "Mật khẩu ứng dụng" (16 ký tự), không dùng mật khẩu Gmail thường.')
  process.exit(1)
})
