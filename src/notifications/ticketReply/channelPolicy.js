/*
 * Chọn kênh gửi (web / email) cho từng người nhận.
 *
 * Tùy chọn của người dùng: user.preferences.notifications
 *   channel:              'both' (mặc định) | 'web' | 'email' | 'none'
 *   skipEmailWhenOnline:  true -> đang online trên web thì không gửi email (mặc định false)
 *
 * Quy tắc:
 *  1. channel = 'none'                       -> không gửi gì.
 *  2. Không có quyền vào web (hasWebAccess=false, vd người gửi ticket qua email
 *     chưa kích hoạt tài khoản)               -> chỉ email.
 *  3. Email chỉ gửi khi: mailer bật + có địa chỉ email + channel cho phép.
 *  4. skipEmailWhenOnline + đang online      -> bỏ email (đã thấy realtime trên web).
 *  5. Dự phòng: nếu theo tùy chọn thì không còn kênh nào (vd chọn 'email' nhưng
 *     mailer tắt) mà người dùng có quyền vào web -> vẫn gửi web để không mất phản hồi.
 */

const VALID_CHANNELS = ['both', 'web', 'email', 'none']

function getPrefs (user) {
  const n = (user && user.preferences && user.preferences.notifications) || {}
  return {
    channel: VALID_CHANNELS.indexOf(n.channel) !== -1 ? n.channel : 'both',
    skipEmailWhenOnline: n.skipEmailWhenOnline === true
  }
}

/**
 * @param {Object}  user
 * @param {Object}  ctx
 * @param {Boolean} ctx.mailEnabled
 * @param {Boolean} ctx.isOnline
 * @returns {{web: Boolean, email: Boolean, reasons: String[]}}
 */
function decideChannels (user, { mailEnabled, isOnline }) {
  const prefs = getPrefs(user)
  const reasons = []

  if (prefs.channel === 'none') {
    return { web: false, email: false, reasons: ['user-opted-out'] }
  }

  const hasWebAccess = user.hasWebAccess !== false
  const hasEmail = typeof user.email === 'string' && user.email.indexOf('@') !== -1

  let web = hasWebAccess && (prefs.channel === 'both' || prefs.channel === 'web')
  let email = prefs.channel === 'both' || prefs.channel === 'email' || !hasWebAccess

  if (!hasWebAccess) reasons.push('no-web-access:email-only')

  if (email && !mailEnabled) {
    email = false
    reasons.push('mailer-disabled')
  }
  if (email && !hasEmail) {
    email = false
    reasons.push('no-email-address')
  }
  if (email && prefs.skipEmailWhenOnline && isOnline && web) {
    email = false
    reasons.push('online:email-skipped')
  }

  if (!web && !email && hasWebAccess) {
    web = true
    reasons.push('fallback:web')
  }

  return { web, email, reasons }
}

module.exports = { decideChannels, getPrefs, VALID_CHANNELS }
