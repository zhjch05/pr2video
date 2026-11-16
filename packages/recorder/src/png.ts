/**
 * Just enough PNG to compare two screenshots: 8-bit greyscale, RGB, grey with
 * alpha or RGBA, not interlaced - what Chromium writes. No dependencies.
 */
import { inflateSync } from "node:zlib"

export type Pixels = { width: number; height: number; channels: number; data: Uint8Array }

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

export function decodePng(file: Uint8Array): Pixels {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  if (view.getUint32(0) !== 0x89504e47) throw new Error("not a PNG file")
  let width = 0
  let height = 0
  let channels = 0
  const idat: Array<Uint8Array> = []
  for (let at = 8; at < file.length; ) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8))
    const body = file.subarray(at + 8, at + 8 + length)
    if (type === "IHDR") {
      width = view.getUint32(at + 8)
      height = view.getUint32(at + 12)
      const depth = body[8]
      const colour = body[9] ?? -1
      channels = CHANNELS[colour] ?? 0
      if (depth !== 8 || !channels || body[12] !== 0)
        throw new Error(`unsupported PNG (depth ${depth}, colour type ${colour}, or interlaced)`)
    } else if (type === "IDAT") idat.push(body)
    else if (type === "IEND") break
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const data = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (data[out + x - channels] ?? 0) : 0
      const b = y > 0 ? (data[out - stride + x] ?? 0) : 0
      const c = x >= channels && y > 0 ? (data[out - stride + x - channels] ?? 0) : 0
      const v = line[x] ?? 0
      let add = 0
      if (filter === 1) add = a
      else if (filter === 2) add = b
      else if (filter === 3) add = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      data[out + x] = (v + add) & 0xff
    }
  }
  return { width, height, channels, data }
}

/**
 * The share of pixels that differ visibly (any colour channel by more than
 * `tolerance`); 1 when the sizes differ.
 */
export function pixelDifference(a: Pixels, b: Pixels, tolerance = 24): number {
  if (a.width !== b.width || a.height !== b.height) return 1
  let differ = 0
  const total = a.width * a.height
  for (let i = 0; i < total; i++) {
    for (let k = 0; k < 3; k++) {
      const ka = Math.min(k, a.channels - 1)
      const kb = Math.min(k, b.channels - 1)
      if (
        Math.abs((a.data[i * a.channels + ka] ?? 0) - (b.data[i * b.channels + kb] ?? 0)) >
        tolerance
      ) {
        differ++
        break
      }
    }
  }
  return differ / total
}
