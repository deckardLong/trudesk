/*
 * Bộ phụ thuộc giả cho Ticket Reply Notifier: thay MongoDB, Socket.io và SMTP bằng bộ nhớ.
 * Dùng chung cho demo và unit test.
 */

const { userMap } = require('../mock-data/helpdesk')

function createMockDeps (opts = {}) {
  const state = {
    clock: opts.startTime || new Date('2026-11-17T09:00:00+07:00').getTime(),
    online: new Set(opts.online || []),
    webNotifications: [], // giống collection "notification" của Trudesk
    socketEvents: [], // sự kiện đã đẩy realtime
    sentEmails: [], // email "đã gửi" qua SMTP giả
    smtpFailuresLeft: opts.smtpFailures || 0,
    settings: {
      mailEnabled: opts.mailEnabled !== false,
      siteUrl: 'https://helpdesk.acme.vn',
      mailbox: 'support@acme.vn',
      replySecret: opts.replySecret === undefined ? 'demo-secret-do-not-use-in-prod' : opts.replySecret
    }
  }

  const users = userMap()

  const deps = {
    now: () => state.clock,
    getSettings: async () => state.settings,
    loadUsers: async ids => {
      const m = new Map()
      for (const id of ids) if (users.has(id)) m.set(id, users.get(id))
      return m
    },
    saveWebNotification: async ({ user, ticket, title, message }) => {
      state.webNotifications.push({ owner: user._id, title, message, ticketUid: ticket.uid, unread: true })
    },
    pushToUser: (user, event, payload) => {
      if (state.online.has(user._id)) state.socketEvents.push({ to: user.username, event, payload })
    },
    isOnline: user => state.online.has(user._id),
    sendEmail: async message => {
      if (state.smtpFailuresLeft > 0) {
        state.smtpFailuresLeft--
        throw new Error('ECONNREFUSED 127.0.0.1:587 (SMTP giả lập lỗi)')
      }
      state.sentEmails.push(message)
      return { messageId: message.messageId }
    },
    outboxOptions: { debounceMs: 60 * 1000, backoffMs: [60 * 1000, 5 * 60 * 1000], maxAttempts: 3 }
  }

  return {
    deps,
    state,
    advance (ms) {
      state.clock += ms
    }
  }
}

module.exports = { createMockDeps }
