/*
 * Nối Ticket Reply Notifier vào Trudesk thật: Mongoose model, mailer SMTP có sẵn, Socket.io.
 *
 * Biến môi trường:
 *   TICKET_REPLY_NOTIFY        'v2' (mặc định) | 'legacy'  -> 'legacy' quay về code thông báo cũ trong events.js
 *   TICKET_REPLY_SECRET        khóa HMAC cho Reply-To token (mặc định dùng tokens:secret trong config.yml)
 *   TICKET_REPLY_MAILBOX       hộp thư nhận trả lời (mặc định: mailer:check:username, rồi mailer:from)
 *   TICKET_NOTIFY_MAIL_MODE    'smtp' (mặc định) | 'mock'  -> 'mock' ghi file .eml vào logs/mock-mailbox, không gửi thật
 *   TICKET_NOTIFY_DEBOUNCE_MS  thời gian gộp email (mặc định 60000)
 *   AI_BOT_USERNAME            username tài khoản dịch vụ của AI Agent (mặc định ai.assistant)
 */

const fs = require('fs')
const path = require('path')
const nconf = require('nconf')
const nodemailer = require('nodemailer')
const winston = require('../../logger')
const { createTicketReplyNotifier } = require('./index')

let instance = null

function isEnabled () {
  return String(process.env.TICKET_REPLY_NOTIFY || 'v2').toLowerCase() !== 'legacy'
}

function settingValue (settings, name) {
  const s = settings.find(x => x.name === name)
  return s ? s.value : undefined
}

async function getSettings () {
  const Setting = require('../../models/setting')
  const settings = await Setting.getSettingsByName([
    'mailer:enable',
    'gen:siteurl',
    'mailer:from',
    'mailer:check:enable',
    'mailer:check:username'
  ])

  const checkUser = settingValue(settings, 'mailer:check:username')
  const imapEnabled = settingValue(settings, 'mailer:check:enable')
  const mailbox =
    process.env.TICKET_REPLY_MAILBOX ||
    (imapEnabled && checkUser && checkUser.indexOf('@') !== -1 ? checkUser : null) ||
    settingValue(settings, 'mailer:from')

  const mockMail = String(process.env.TICKET_NOTIFY_MAIL_MODE || '').toLowerCase() === 'mock'

  return {
    mailEnabled: mockMail || !!settingValue(settings, 'mailer:enable'),
    siteUrl: settingValue(settings, 'gen:siteurl') || '',
    mailbox,
    // Chỉ gắn Reply-To khi IMAP đang bật (có người đọc hộp thư), hoặc ép bằng TICKET_REPLY_MAILBOX.
    replySecret:
      imapEnabled || process.env.TICKET_REPLY_MAILBOX
        ? process.env.TICKET_REPLY_SECRET || nconf.get('tokens:secret') || null
        : null
  }
}

async function loadUsers (ids) {
  const User = require('../../models/user')
  const permissions = require('../../permissions')
  const docs = await User.find({ _id: { $in: ids } })
    .select('username fullname email role deleted preferences')
    .lean()

  const map = new Map()
  for (const u of docs) {
    map.set(String(u._id), {
      ...u,
      _id: String(u._id),
      isStaff: permissions.canThis(u.role, 'tickets:notes'),
      // Tài khoản dịch vụ của AI Agent (comment tự động của nó không gửi email cho nhân viên)
      isBot: u.username === String(process.env.AI_BOT_USERNAME || 'ai.assistant').toLowerCase(),
      hasWebAccess: true
    })
  }
  return map
}

async function saveWebNotification ({ user, ticket, title, message }) {
  const Notification = require('../../models/notification')
  await new Notification({
    owner: user._id,
    title,
    message: message || title,
    type: 0,
    data: { ticket: { _id: ticket._id, uid: ticket.uid } },
    unread: true
  }).save()
}

function sharedSockets () {
  return require('../../socketio/index').shared
}

function pushToUser (user, event, payload) {
  const utils = require('../../helpers/utils')
  const shared = sharedSockets()
  if (!user.username) return
  utils.sendToUser(shared.sockets, shared.usersOnline, user.username, event, payload)
}

function isOnline (user) {
  const shared = sharedSockets()
  if (!user.username || !shared.usersOnline) return false
  const name = user.username.toLowerCase()
  return Object.keys(shared.usersOnline).some(k => k.toLowerCase() === name)
}

let mockTransport = null
async function sendEmailMock (message) {
  if (!mockTransport) mockTransport = nodemailer.createTransport({ streamTransport: true, buffer: true })
  const info = await mockTransport.sendMail({ from: 'helpdesk@mock.local', ...message })
  const dir = path.resolve(__dirname, '../../../logs/mock-mailbox')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${Date.now()}-${message.to.replace(/[^a-z0-9@.]/gi, '_')}.eml`)
  fs.writeFileSync(file, info.message)
  winston.info(`[ticketReply] (mock) email to ${message.to} saved to ${file}`)
  return info
}

function sendEmailSmtp (message) {
  const mailer = require('../../mailer')
  return new Promise((resolve, reject) => {
    mailer.sendMail(message, (err, info) => (err ? reject(err instanceof Error ? err : new Error(err)) : resolve(info)))
  })
}

function get () {
  if (instance) return instance

  const mockMail = String(process.env.TICKET_NOTIFY_MAIL_MODE || '').toLowerCase() === 'mock'
  instance = createTicketReplyNotifier({
    getSettings,
    loadUsers,
    saveWebNotification,
    pushToUser,
    isOnline,
    sendEmail: mockMail ? sendEmailMock : sendEmailSmtp,
    logger: winston,
    outboxOptions: {
      debounceMs: Number(process.env.TICKET_NOTIFY_DEBOUNCE_MS || 60000)
    }
  })
  instance.start(15000)
  return instance
}

module.exports = { get, isEnabled, getSettings }
