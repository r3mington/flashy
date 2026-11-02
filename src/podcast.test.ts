import { describe, expect, it } from 'vitest'
import { clipKey, markAt, parseWav, stitch, type Pcm } from './podcast'

/** A 16-bit mono WAV of `n` samples, all set to `value`. */
function wav(n: number, rate = 24000, value = 1000, extraChunk = false): Uint8Array {
  const extra = extraChunk ? 12 : 0
  const out = new Uint8Array(44 + extra + n * 2)
  const v = new DataView(out.buffer)
  const str = (o: number, s: string) => [...s].forEach((ch, i) => (out[o + i] = ch.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + extra + n * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  let o = 36
  if (extraChunk) {
    str(o, 'LIST')
    v.setUint32(o + 4, 4, true)
    o += 12
  }
  str(o, 'data')
  v.setUint32(o + 4, n * 2, true)
  for (let i = 0; i < n; i++) v.setInt16(o + 8 + i * 2, value, true)
  return out
}

describe('parseWav', () => {
  it('finds the samples and the rate', () => {
    const p = parseWav(wav(100, 24000))
    expect(p.rate).toBe(24000)
    expect(p.samples.length).toBe(200)
  })

  it('walks past chunks before the data', () => {
    expect(parseWav(wav(50, 24000, 1000, true)).samples.length).toBe(100)
  })

  it('takes an empty clip as no audio', () => {
    expect(parseWav(new Uint8Array()).samples.length).toBe(0)
  })

  it('refuses something that is not a WAV', () => {
    expect(() => parseWav(new Uint8Array(64))).toThrow()
  })
})

describe('stitch', () => {
  const clips: Pcm[] = [parseWav(wav(24000)), parseWav(wav(12000)), parseWav(wav(48000))]

  it('puts the pause after every sentence but the last, and maps each one', () => {
    const { wav: out, marks } = stitch(clips, 2)
    expect(marks).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 3.5 },
      { start: 5.5, end: 7.5 },
    ])
    const back = parseWav(out)
    expect(back.samples.length / 2 / back.rate).toBe(7.5)
  })

  it('leaves the pause silent and the speech as it was', () => {
    const { wav: out } = stitch(clips, 1)
    const v = new DataView(out.buffer)
    const sampleAt = (sec: number) => v.getInt16(44 + Math.round(sec * 24000) * 2, true)
    expect(sampleAt(0.5)).toBe(1000)
    expect(sampleAt(1.5)).toBe(0)
    expect(sampleAt(2.2)).toBe(1000)
  })

  it('needs no pause at all', () => {
    expect(stitch(clips, 0).marks[2]).toEqual({ start: 1.5, end: 3.5 })
  })

  it('refuses clips made at different rates', () => {
    expect(() => stitch([parseWav(wav(10, 24000)), parseWav(wav(10, 48000))], 1)).toThrow()
  })
})

describe('markAt', () => {
  const marks = [
    { start: 0, end: 1 },
    { start: 3, end: 3.5 },
  ]
  it('is the sentence playing, or the one just read during a pause', () => {
    expect(markAt(marks, 0.2)).toBe(0)
    expect(markAt(marks, 2)).toBe(0)
    expect(markAt(marks, 3.1)).toBe(1)
  })
})

describe('clipKey', () => {
  it('changes with the words, the voice and the style', () => {
    const k = clipKey(1, 'Kore', 'natural', 'Halo.')
    expect(clipKey(1, 'Kore', 'natural', ' Halo. ')).toBe(k)
    expect(clipKey(1, 'Kore', 'natural', 'Halo!')).not.toBe(k)
    expect(clipKey(1, 'Puck', 'natural', 'Halo.')).not.toBe(k)
    expect(clipKey(1, 'Kore', 'clear', 'Halo.')).not.toBe(k)
  })
})
