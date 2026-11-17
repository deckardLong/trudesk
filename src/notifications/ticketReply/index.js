/*
 * Ticket Reply Notifier: khi ticket có phản hồi mới, báo cho người liên quan qua WEB và/hoặc EMAIL (SMTP).
 *
 *   ticket:comment:added --> resolveRecipients --> decideChannels (từng người)
 *                                                   |- web  : lưu Notification + đẩy Socket.io (ngay lập tức)
 *                                                   `- email: Outbox (gộp 60s, chống trùng, retry) --> SMTP
 *
 * Mọi phụ thuộc bên ngoài (DB, socket, SMTP, settings) được TIÊM VÀO qua `deps`, nên:
 *  - Trong Trudesk: dùng trudeskAdapters.js (Mongoose model, mailer có sẵn, socket thật).
 *  - Trong demo/test: dùng mock (xem demo/ticket-reply).
 */

const { resolveRecipients, idOf } = require('./recipientResolver')
const { decideChannels } = require('./channelPolicy')
const { composeReplyEmail } = require('./emailComposer')
const { buildReplyAddress } = require('./replyToken')
const { Outbox } = require('./outbox')

const SOCKET_EVENT = '$trudesk:client:ticket:reply'

function lastOf (arr) {
  return arr && arr.length ? arr[arr.length - 1] : undefined
}

function stripHtml (html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @param {Object} deps
 * @param {Function} deps.getSettings        async () => { mailEnabled, siteUrl, mailbox, replySecret }
 * @param {Function} deps.loadUsers          async (ids: String[]) => Map<id, user>
 *                                           user: { _id, username, fullname, email, deleted, isStaff, hasWebAccess, preferences }
 * @param {Function} deps.saveWebNotification async ({ user, ticket, title, message }) => void
 * @param {Function} deps.pushToUser         (user, event, payload) => void
 * @param {Function} deps.isOnline           (user) => Boolean
 * @param {Function} deps.sendEmail          async (message) => info
 * @param {Object}   [deps.logger]
 * @param {Function} [deps.now]
 * @param {Object}   [deps.outboxOptions]    { debounceMs, backoffMs, maxAttempts }
 */
function createTicketReplyNotifier (deps) {
  const logger = deps.logger || { debug () {}, info () {}, warn () {} }
  const now = deps.now || (() => Date.now())
  let cachedSettings = null

  const outbox = new Outbox({
    now,
    logger,
    ...(deps.outboxOptions || {}),
    deliver: async job => {
      const settings = cachedSettings || (await deps.getSettings())
      const replyTo = settings.replySecret
        ? buildReplyAddress({ uid: job.ticket.uid, mailbox: settings.mailbox, secret: settings.replySecret })
        : null
      const message = composeReplyEmail({
        ticket: job.ticket,
        comments: job.comments,
        recipient: job.recipient,
        siteUrl: settings.siteUrl,
        replyTo,
        mailbox: settings.mailbox
      })
      job.message = message
      await deps.sendEmail(message)
    }
  })

  /**
   * Gọi khi ticket có comment/note mới.
   * @param {Object}  evt
   * @param {Object}  evt.ticket     ticket sau khi lưu (có comments, owner, assignee, subscribers, status)
   * @param {Object}  evt.comment    { _id?, owner, date, comment(html) }
   * @param {Boolean} [evt.isInternal=false]
   * @returns {Promise<Array>} báo cáo từng người nhận (dùng cho log/demo)
   */
  async function onCommentAdded ({ ticket, comment, isInternal = false }) {
    const settings = await deps.getSettings()
    cachedSettings = settings

    // Comment được emit trước khi có _id; lấy _id từ bản đã lưu trong ticket.
    const list = isInternal ? ticket.notes : ticket.comments
    const saved = comment._id ? comment : lastOf(list) || comment
    const commentId = String(saved._id || `${ticket.uid}-${new Date(comment.date).getTime()}`)
    const authorId = idOf(comment.owner)

    const ids = [idOf(ticket.owner), idOf(ticket.assignee), authorId]
      .concat((ticket.subscribers || []).map(idOf))
      .filter(Boolean)
    const users = await deps.loadUsers(Array.from(new Set(ids)))
    const author = users.get(authorId)
    const authorName = author ? author.fullname || author.username : 'Hỗ trợ viên'

    const recipients = resolveRecipients({ ticket, authorId, isInternal, users })
    const ticketSnapshot = {
      _id: String(ticket._id),
      uid: ticket.uid,
      subject: ticket.subject,
      status: ticket.status ? { name: ticket.status.name } : null
    }
    // Comment dùng trường `comment`, internal note dùng trường `note` (xem api/v1/tickets.js).
    const bodyHtml = comment.comment != null ? comment.comment : comment.note || ''
    const commentSnapshot = { _id: commentId, authorName, date: comment.date || new Date(now()), html: bodyHtml }
    const title = isInternal ? `Ghi chú nội bộ mới ở Ticket #${ticket.uid}` : `Ticket #${ticket.uid} có phản hồi mới`

    const report = []
    for (const { user, reason } of recipients) {
      const online = deps.isOnline ? !!deps.isOnline(user) : false
      const channels = decideChannels(user, { mailEnabled: !!settings.mailEnabled && !isInternal, isOnline: online })
      // Trả lời tự động của bot: email chỉ dành cho người dùng; nhân viên theo dõi trên web, tránh spam hộp thư.
      if (author && author.isBot && user.isStaff && channels.email) {
        channels.email = false
        channels.reasons.push('bot-reply:staff-web-only')
        if (!channels.web && user.hasWebAccess !== false) channels.web = true
      }
      const entry = { to: user.username || user.email, reason, web: 'skipped', email: 'skipped', notes: channels.reasons }

      if (channels.web) {
        try {
          await deps.saveWebNotification({ user, ticket: ticketSnapshot, title, message: ticket.subject })
          deps.pushToUser(user, SOCKET_EVENT, {
            ticketUid: ticket.uid,
            ticketId: ticketSnapshot._id,
            title,
            preview: stripHtml(bodyHtml).slice(0, 140),
            author: authorName,
            isInternal
          })
          entry.web = online ? 'sent:realtime' : 'sent:stored'
        } catch (err) {
          entry.web = 'error'
          logger.warn(`[ticketReply] web notify failed for ${entry.to}: ${err && err.message}`)
        }
      }

      if (channels.email) {
        entry.email = outbox.enqueue({
          idempotencyKey: `${commentId}:${idOf(user._id)}:email`,
          groupKey: `${ticketSnapshot._id}:${idOf(user._id)}`,
          recipient: { _id: idOf(user._id), email: user.email, fullname: user.fullname, reason },
          ticket: ticketSnapshot,
          comment: commentSnapshot
        })
      }

      report.push(entry)
    }

    logger.debug(`[ticketReply] ticket #${ticket.uid}: ${report.length} recipient(s)`)
    return report
  }

  return {
    onCommentAdded,
    outbox,
    flush: () => outbox.flushDue(),
    start: intervalMs => outbox.start(intervalMs),
    stop: () => outbox.stop()
  }
}

module.exports = { createTicketReplyNotifier, SOCKET_EVENT }
