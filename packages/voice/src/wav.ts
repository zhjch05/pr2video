/**
 * Just enough WAV to measure a narration and to write one: every voice here
 * produces WAV first, the timeline needs its length, and kokoro hands back raw
 * samples.
 */

/** A RIFF/WAVE file's length in milliseconds, read from its `fmt ` and `data` chunks. */
export function wavDurationMs(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file")
  let byteRate: number | null = null
  let at = 12
  while (at + 8 <= bytes.length) {
    const id = tag(at)
    let size = view.getUint32(at + 4, true)
    if (id === "fmt ") byteRate = view.getUint32(at + 16, true)
    if (id === "data") {
      if (!byteRate) throw new Error("WAV data chunk before its fmt chunk")
      // A streaming writer may leave the size as 0 or 0xFFFFFFFF: the rest of the file.
      if (size === 0 || size === 0xffffffff || at + 8 + size > bytes.length)
        size = bytes.length - at - 8
      return Math.round((size / byteRate) * 1_000)
    }
    at += 8 + size + (size % 2)
  }
  throw new Error("WAV file has no data chunk")
}

/** Mono float samples in [-1, 1] as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  const write = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i)
  }
  write(0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  write(8, "WAVE")
  write(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, "data")
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return out
}
