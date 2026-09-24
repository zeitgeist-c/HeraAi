import { describe, expect, it } from 'vitest'

import {
  base64ToBytes,
  bytesToBase64,
  encodeAudioBufferAsWav,
  splitWavIntoChunks,
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

  it('splits a long WAV into equal chunks that each keep a valid header', () => {
    const frames = 16000 * 70
    const silence = new Float32Array(frames)
    const wav = encodeAudioBufferAsWav({
      length: frames,
      numberOfChannels: 1,
      sampleRate: 16000,
      getChannelData: () => silence,
    })

    const chunks = splitWavIntoChunks(wav)
    const chunkPcmBytes = 16000 * 30 * 2
    expect(chunks).toHaveLength(3)
    expect(chunks[0].byteLength).toBe(44 + chunkPcmBytes)
    expect(chunks[1].byteLength).toBe(44 + chunkPcmBytes)
    expect(chunks[2].byteLength).toBe(44 + 16000 * 10 * 2)

    for (const chunk of chunks) {
      const view = new DataView(chunk.buffer)
      expect(new TextDecoder().decode(chunk.subarray(0, 4))).toBe('RIFF')
      expect(new TextDecoder().decode(chunk.subarray(8, 12))).toBe('WAVE')
      expect(view.getUint32(24, true)).toBe(16000)
      expect(view.getUint16(22, true)).toBe(1)
      expect(view.getUint32(4, true)).toBe(chunk.byteLength - 8)
      expect(view.getUint32(40, true)).toBe(chunk.byteLength - 44)
    }

    const totalPcmBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength - 44, 0)
    expect(totalPcmBytes).toBe(frames * 2)
  })

  it('keeps a short WAV in a single piece', () => {
    const frames = 16000 * 5
    const silence = new Float32Array(frames)
    const wav = encodeAudioBufferAsWav({
      length: frames,
      numberOfChannels: 1,
      sampleRate: 16000,
      getChannelData: () => silence,
    })
    expect(splitWavIntoChunks(wav)).toEqual([wav])
  })
})
