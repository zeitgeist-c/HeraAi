import { describe, expect, it } from 'vitest'

import {
  base64ToBytes,
  bytesToBase64,
  createAudioBufferFromPcm16,
  encodeAudioBufferAsWav,
  normalizeMarkdownForSpeech,
  splitSpeechText,
} from './audioUtils'

describe('audio utilities', () => {
  it('round-trips byte arrays through base64', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255])
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })

  it('encodes a mono 16-bit PCM WAV and downmixes channels', () => {
    const wav = encodeAudioBufferAsWav({
      length: 2,
      numberOfChannels: 2,
      sampleRate: 16000,
      getChannelData: channel => channel === 0 ? new Float32Array([1, -1]) : new Float32Array([0, 0]),
    })
    const view = new DataView(wav.buffer)
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getInt16(44, true)).toBeGreaterThan(16000)
    expect(view.getInt16(46, true)).toBeLessThan(-16000)
  })

  it('converts PCM16 bytes into a Web Audio buffer', () => {
    const created = { channel: new Float32Array(2) }
    const context = {
      createBuffer: (_channels, length, sampleRate) => ({
        length,
        sampleRate,
        getChannelData: () => created.channel,
      }),
    }
    const bytes = new Uint8Array([0xff, 0x7f, 0x00, 0x80])
    const result = createAudioBufferFromPcm16(context, bytes, 24000)
    expect(result.sampleRate).toBe(24000)
    expect(created.channel[0]).toBeCloseTo(0.9999, 3)
    expect(created.channel[1]).toBe(-1)
  })

  it('normalizes Markdown while skipping fenced code', () => {
    const text = normalizeMarkdownForSpeech('# Title\n[OpenAI](https://openai.com)\n```js\nalert(1)\n```', 'Code skipped.')
    expect(text).toBe('Title OpenAI Code skipped.')
  })

  it('splits long speech at a nearby sentence boundary and preserves order', () => {
    const text = `${'First sentence. '.repeat(80)}Last sentence.`
    const chunks = splitSpeechText(text, 200)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.length <= 201)).toBe(true)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(text.trim().replace(/\s+/g, ' '))
  })
})
