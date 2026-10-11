// npm and magpie both want the icon at small sizes (the market card renders it
// at 32-40px, npm's listing at 128). Resizing a PNG means decoding it, and Node
// has no image library — so this decodes the IDAT itself: inflate, undo the
// per-scanline filters, box-filter down, re-encode. It only has to handle what
// icon.png actually is (8-bit RGBA, non-interlaced), and says so if not.
import { readFileSync, writeFileSync } from "node:fs"
import { inflateSync, deflateSync } from "node:zlib"
import { crc32 } from "node:zlib"

// ---- PNG decode --------------------------------------------------------------
function decodePNG(buf) {
  if (buf.subarray(1, 4).toString() !== "PNG") throw new Error("not a PNG")
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const depth = buf[24]
  const color = buf[25]
  if (depth !== 8) throw new Error(`bit depth ${depth}, only 8 is handled`)
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color]
  if (!channels) throw new Error(`colour type ${color}`)

  // collect the IDAT chunks
  const parts = []
  let at = 8
  while (at < buf.length) {
    const len = buf.readUInt32BE(at)
    const type = buf.subarray(at + 4, at + 8).toString()
    if (type === "IDAT") parts.push(buf.subarray(at + 8, at + 8 + len))
    at += 12 + len
  }
  const raw = inflateSync(Buffer.concat(parts))

  // undo the per-scanline filters, in place, into a flat pixel buffer
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let v = line[x]
      switch (filter) {
        case 0: break
        case 1: v = (v + a) & 255; break
        case 2: v = (v + b) & 255; break
        case 3: v = (v + ((a + b) >> 1)) & 255; break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
          break
        }
        default: throw new Error(`filter ${filter}`)
      }
      cur[x] = v
    }
  }
  return { width, height, channels, data: out }
}

// ---- box-filter resize -------------------------------------------------------
function resize(img, size) {
  const { width: w, height: h, channels: ch, data } = img
  const out = Buffer.alloc(size * size * ch)
  const ratio = Math.min(w / size, h / size)
  const cw = Math.max(1, Math.round(w / ratio))
  const chh = Math.max(1, Math.round(h / ratio))
  const x0 = Math.floor((w - cw) / 2)
  const y0 = Math.floor((h - chh) / 2)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = x0 + Math.floor((x * cw) / size)
      const sy = y0 + Math.floor((y * chh) / size)
      for (let c = 0; c < ch; c++) {
        out[(y * size + x) * ch + c] = data[(sy * w + sx) * ch + c]
      }
    }
  }
  return { width: size, height: size, channels: ch, data: out }
}

// ---- PNG encode --------------------------------------------------------------
function chunk(type, body) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  const td = Buffer.concat([Buffer.from(type, "ascii"), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td) >>> 0)
  return Buffer.concat([len, td, crc])
}

function encodePNG({ width, height, channels, data }) {
  const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels]
  const stride = width * channels
  // one filter byte (0 = none) per scanline
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

// ---- do it --------------------------------------------------------------------
const src = decodePNG(readFileSync("icon.png"))
console.log(`source: ${src.width}x${src.height}, ${src.channels} channels`)

for (const size of [512, 256, 128, 64, 32]) {
  const out = encodePNG(resize(src, size))
  writeFileSync(`icon-${size}.png`, out)
  console.log(`  icon-${size}.png  ${out.length} bytes`)
}
console.log("done")