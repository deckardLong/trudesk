/*
 * Adapter Trudesk cho email trả lời đi vào (IMAP -> mailCheck -> đây).
 * Quyết định nằm ở inboundReply.js (hàm thuần); file này chỉ thực thi trên Mongoose.
 */

const winston = require('../../logger')
const emitter = require('../../emitter')
const { resolveInboundReply } = require('./inboundReply')
const { escapeHtml } = require('./emailComposer')
const { getSettings } = require('./trudeskAdapters')

function textToHtml (text) {
  return escapeHtml(text).replace(/\n/g, '<br>')
}

function findTicketByUid (uid) {
  const Ticket = require('../../models/ticket')
  return new Promise((resolve, reject) => {
    Ticket.getTicketByUid(uid, (err, ticket) => (err ? reject(err) : resolve(ticket)))
  })
}

async function findReopenStatus () {
  const Status = require('../../models/ticketStatus')
  const open = await Status.findOne({ uid: 1, isResolved: false })
  if (open) return open
  return Status.findOne({ isResolved: false }).sort({ order: 1 })
}

/**
 * @param {Object} message { from, to: String[], text, headers }
 * @returns {Promise<{handled: Boolean, action: String, relatedTicketUid?: Number}>}
 *          handled=false -> mailCheck tiếp tục tạo ticket mới như cũ.
 */
async function tryHandleReply (message) {
  const settings = await getSettings()
  if (!settings.replySecret) return { handled: false, action: 'new_ticket', reason: 'reply-disabled' }

  const decision = await resolveInboundReply(
    { from: message.from, to: message.to, text: message.text, headers: message.headers },
    { secret: settings.replySecret, findTicketByUid }
  )

  if (decision.action === 'ignore' || decision.action === 'reject') {
    winston.info(`[ticketReply:inbound] ${decision.action} mail from ${message.from}: ${decision.reason}`)
    return { handled: true, action: decision.action }
  }

  if (decision.action === 'new_ticket') {
    return { handled: false, action: 'new_ticket', relatedTicketUid: decision.relatedTicketUid }
  }

  const ticket = decision.ticket
  const comment = { owner: decision.senderId, date: new Date(), comment: textToHtml(decision.body) }

  if (decision.action === 'reopen') {
    const status = await findReopenStatus()
    if (status) await ticket.setStatus(decision.senderId, status._id)
  }

  ticket.updated = Date.now()
  ticket.comments.push(comment)
  ticket.history.push({
    action: 'ticket:comment:added',
    description: decision.action === 'reopen' ? 'Comment was added via email (ticket reopened)' : 'Comment was added via email',
    owner: decision.senderId
  })

  const saved = await ticket.save()
  emitter.emit('ticket:comment:added', saved, comment, '')
  winston.info(`[ticketReply:inbound] ${decision.action}: ticket #${ticket.uid} from ${message.from}`)

  return { handled: true, action: decision.action }
}

module.exports = { tryHandleReply }
