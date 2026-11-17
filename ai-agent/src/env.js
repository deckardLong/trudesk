/*
 * Nạp biến môi trường từ ai-agent/.env (KEY=VALUE, bỏ dòng #). Biến đã đặt sẵn trong shell được ưu tiên.
 * Không dùng thư viện dotenv để service không cần thêm dependency.
 */

const fs = require('fs')
const path = require('path')

function loadEnvFile (file = path.resolve(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return false
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return true
}

module.exports = { loadEnvFile }
