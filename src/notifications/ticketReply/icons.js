/*
 * Icon cho email, lấy từ bộ Material Design Icons CÓ SẴN trong Trudesk
 * (public/font/material-design-icons + src/sass/materialize/components/_icons-material-design.scss).
 *
 * Email client (Gmail, Outlook) không hiển thị webfont hay SVG nhúng, nên glyph được vẽ thành PNG
 * ngay trong Node và đính kèm dạng ảnh nội tuyến (CID). Không tải gì từ internet, không thêm thư viện:
 * chỉ dùng zlib có sẵn của Node.
 *
 *   iconAttachment('hardware-headset-mic', { color: '#2b5ea7' })
 *     -> { filename, content: <PNG Buffer>, cid, contentType }   (dùng <img src="cid:..."> trong HTML)
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ROOT = path.resolve(__dirname, '../../..')
const FONT_FILE = path.join(ROOT, 'public/font/material-design-icons/Material-Design-Icons.svg')
const CSS_FILE = path.join(ROOT, 'src/sass/materialize/components/_icons-material-design.scss')

let font = null
let classMap = null
const cache = new Map()

function loadFont () {
  if (font) return font
  const svg = fs.readFileSync(FONT_FILE, 'utf8')
  const face = /<font-face[^>]*units-per-em="(\d+)"[^>]*ascent="(-?\d+)"/.exec(svg)
  const fontTag = /<font[^>]*horiz-adv-x="(\d+)"/.exec(svg)
  const glyphs = new Map()
  const re = /<glyph unicode="&#x([0-9a-f]+);"([^>]*)>/gi
  let m
  while ((m = re.exec(svg))) {
    const d = /\sd="([^"]*)"/.exec(m[2])
    const adv = /horiz-adv-x="(\d+)"/.exec(m[2])
    if (d && d[1]) glyphs.set(m[1].toLowerCase(), { d: d[1], adv: adv ? Number(adv[1]) : null })
  }
  font = {
    unitsPerEm: face ? Number(face[1]) : 1024,
    ascent: face ? Number(face[2]) : 960,
    defaultAdv: fontTag ? Number(fontTag[1]) : 1024,
    glyphs
  }
  return font
}

/** Tên lớp CSS (bỏ tiền tố "mdi-") -> mã glyph, đọc từ file SCSS của Trudesk. */
function codepointOf (name) {
  if (!classMap) {
    classMap = new Map()
    const css = fs.readFileSync(CSS_FILE, 'utf8')
    const re = /\.mdi-([a-z0-9-]+):before\s*\{\s*content:\s*"\\([0-9a-f]+)"/gi
    let m
    while ((m = re.exec(css))) classMap.set(m[1], m[2].toLowerCase())
  }
  const cp = classMap.get(name)
  if (!cp) throw new Error(`icons: không có icon mdi-${name} trong thư viện`)
  return cp
}

// ---------- Path SVG -> các đa giác (đã làm phẳng đường cong) ----------
function parsePath (d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) || []
  const polys = []
  let poly = null
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  let lastCtrl = null
  let cmd = null
  let i = 0
  const num = () => Number(tokens[i++])
  const isNum = () => i < tokens.length && !/[a-zA-Z]/.test(tokens[i])
  const lineTo = (nx, ny) => {
    poly.push([nx, ny])
    x = nx
    y = ny
  }
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    const x0 = x
    const y0 = y
    for (let k = 1; k <= 12; k++) {
      const t = k / 12
      const u = 1 - t
      lineTo(
        u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
      )
    }
    lastCtrl = [x2, y2]
  }
  const quad = (x1, y1, x2, y2) => {
    const x0 = x
    const y0 = y
    for (let k = 1; k <= 10; k++) {
      const t = k / 10
      const u = 1 - t
      lineTo(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2)
    }
    lastCtrl = [x1, y1]
  }

  while (i < tokens.length) {
    if (!isNum()) cmd = tokens[i++]
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    switch (cmd.toLowerCase()) {
      case 'm': {
        poly = []
        polys.push(poly)
        lineTo(ox + num(), oy + num())
        sx = x
        sy = y
        cmd = rel ? 'l' : 'L' // các cặp số tiếp theo là lineto
        lastCtrl = null
        break
      }
      case 'l': lineTo(ox + num(), oy + num()); lastCtrl = null; break
      case 'h': lineTo(ox + num(), y); lastCtrl = null; break
      case 'v': lineTo(x, oy + num()); lastCtrl = null; break
      case 'c': { const a = [num(), num(), num(), num(), num(), num()]; cubic(ox + a[0], oy + a[1], ox + a[2], oy + a[3], ox + a[4], oy + a[5]); break }
      case 's': {
        const a = [num(), num(), num(), num()]
        const c1 = lastCtrl ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y]
        cubic(c1[0], c1[1], ox + a[0], oy + a[1], ox + a[2], oy + a[3])
        break
      }
      case 'q': { const a = [num(), num(), num(), num()]; quad(ox + a[0], oy + a[1], ox + a[2], oy + a[3]); break }
      case 't': {
        const a = [num(), num()]
        const c1 = lastCtrl ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y]
        quad(c1[0], c1[1], ox + a[0], oy + a[1])
        break
      }
      case 'z': lineTo(sx, sy); lastCtrl = null; break
      default: throw new Error(`icons: lệnh path "${cmd}" chưa hỗ trợ`)
    }
  }
  return polys
}

// ---------- Tô đa giác (nonzero), khử răng cưa bằng siêu lấy mẫu 4x4 ----------
function rasterize (polys, size, toPixel) {
  const SS = 4
  const edges = []
  for (const p of polys) {
    for (let k = 0; k < p.length - 1; k++) {
      const a = toPixel(p[k])
      const b = toPixel(p[k + 1])
      if (a[1] !== b[1]) edges.push(a[1] < b[1] ? [a[0], a[1], b[0], b[1], 1] : [b[0], b[1], a[0], a[1], -1])
    }
  }
  const coverage = new Float32Array(size * size)
  for (let row = 0; row < size * SS; row++) {
    const sy = (row + 0.5) / SS
    const xs = []
    for (const [x0, y0, x1, y1, w] of edges) {
      if (sy >= y0 && sy < y1) xs.push([x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0), w])
    }
    xs.sort((a, b) => a[0] - b[0])
    let wind = 0
    for (let k = 0; k < xs.length - 1; k++) {
      wind += xs[k][1]
      if (wind === 0) continue
      const from = Math.max(0, xs[k][0])
      const to = Math.min(size, xs[k + 1][0])
      for (let sxi = Math.ceil(from * SS - 0.5); (sxi + 0.5) / SS < to; sxi++) {
        coverage[Math.floor(row / SS) * size + Math.floor(sxi / SS)] += 1 / (SS * SS)
      }
    }
  }
  return coverage
}

// ---------- PNG RGBA tối giản ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32 (buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function encodePng (size, coverage, [r, g, b]) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let yy = 0; yy < size; yy++) {
    const off = yy * (size * 4 + 1)
    raw[off] = 0
    for (let xx = 0; xx < size; xx++) {
      const a = Math.round(Math.min(1, coverage[yy * size + xx]) * 255)
      raw.set([r, g, b, a], off + 1 + xx * 4)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function hexToRgb (hex) {
  const h = hex.replace('#', '')
  return [0, 2, 4].map(k => parseInt(h.substr(k, 2), 16))
}

/**
 * @param {String} name   tên icon trong thư viện, bỏ tiền tố "mdi-" (vd 'hardware-headset-mic')
 * @param {Object} opts   { size: px thật của ảnh (mặc định 40 = 20px hiển thị x2 cho màn retina), color }
 * @returns {Buffer} PNG
 */
function iconPng (name, { size = 40, color = '#2b5ea7' } = {}) {
  const key = `${name}|${size}|${color}`
  if (cache.has(key)) return cache.get(key)
  const f = loadFont()
  const glyph = f.glyphs.get(codepointOf(name))
  if (!glyph) throw new Error(`icons: thiếu glyph cho mdi-${name}`)
  const adv = glyph.adv || f.defaultAdv
  const scale = size / Math.max(adv, f.unitsPerEm)
  // Font SVG có trục y hướng lên, gốc ở baseline -> lật trục và dời theo ascent.
  const toPixel = ([px, py]) => [px * scale, (f.ascent - py) * scale]
  const png = encodePng(size, rasterize(parsePath(glyph.d), size, toPixel), hexToRgb(color))
  cache.set(key, png)
  return png
}

/** Đính kèm nội tuyến cho nodemailer. */
function iconAttachment (name, opts = {}) {
  const cid = `mdi-${name}@helpdesk`
  return { filename: `${name}.png`, content: iconPng(name, opts), cid, contentType: 'image/png', contentDisposition: 'inline' }
}

module.exports = { iconPng, iconAttachment, codepointOf, parsePath }
