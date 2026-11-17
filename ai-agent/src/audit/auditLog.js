/*
 * Audit Log (sơ đồ 3, 5): ghi lại prompt (đã che PII), phản hồi, quyết định, người duyệt.
 * Mỗi dòng một JSON (JSONL) để dễ grep và nạp vào CloudWatch/ELK.
 */

const fs = require('fs')
const path = require('path')

class AuditLog {
  constructor ({ filePath, now = () => Date.now() } = {}) {
    this.filePath = filePath || ''
    this.now = now
    this.entries = []
    if (this.filePath) fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
  }

  write (entry) {
    const record = { at: new Date(this.now()).toISOString(), ...entry }
    this.entries.push(record)
    if (this.filePath) fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n')
    return record
  }

  find (filter) {
    return this.entries.filter(e => Object.entries(filter).every(([k, v]) => e[k] === v))
  }
}

module.exports = { AuditLog }
