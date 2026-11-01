import { describe, expect, it, vi } from 'vitest'

import { appendLiveText, floatTo16BitPCM, LiveTranscriber, supportsLiveDictation } from './liveTranscribe'

describe('liveTranscribe helpers', () => {
  it('reports live dictation as unsupported without AudioContext', () => {
    expect(supportsLiveDictation()).toBe(false)
  })

  it('converts float samples to 16-bit PCM with clipping', () => {
    const pcm = floatTo16BitPCM(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]))
    expect([...pcm]).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768])
  })

  it('joins live text with spaces and stays empty-safe', () => {
    expect(appendLiveText('', '')).toBe('')
    expect(appendLiveText('', 'merhaba')).toBe('merhaba')
    expect(appendLiveText('merhaba', '')).toBe('merhaba')
    expect(appendLiveText('merhaba', 'dünya')).toBe('merhaba dünya')
    expect(appendLiveText('selam,', 'dünya')).toBe('selam,dünya'.replace(',', ', '))
  })
})

function fakeSession() {
  return { sent: [], closed: false, sendRealtimeInput(params) { this.sent.push(params) }, close() { this.closed = true } }
}

describe('LiveTranscriber', () => {
  it('connects, routes transcripts, and streams PCM as base64', async () => {
    const session = fakeSession()
    const connect = vi.fn().mockResolvedValue(session)
    const stopped = []
    const createAudioStack = vi.fn().mockImplementation(async (_stream, onPcm) => {
      createAudioStack.emit = onPcm
      return { sampleRate: 16000, stop: async () => stopped.push(true) }
    })
    const events = []
    const transcriber = new LiveTranscriber({
      createClient: () => ({ live: { connect } }),
      createAudioStack,
      onInterim: text => events.push(['interim', text]),
      onFinal: text => events.push(['final', text]),
    })
    await transcriber.start({ apiKey: 'key', stream: {} })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect.mock.calls[0][0].model).toContain('transcribe-live')

    createAudioStack.emit(new Float32Array([0.5, -0.5]))
    expect(session.sent).toHaveLength(1)
    expect(session.sent[0].audio.mimeType).toBe('audio/pcm;rate=16000')
    expect(typeof session.sent[0].audio.data).toBe('string')

    transcriber.handleMessage({ serverContent: { interimInputTranscription: { text: 'mera' } } })
    transcriber.handleMessage({ serverContent: { inputTranscription: { text: 'merhaba ' } } })
    transcriber.handleMessage({ serverContent: {} })
    expect(events).toEqual([['interim', 'mera'], ['final', 'merhaba']])

    await transcriber.finish({ graceMs: 0 })
    expect(session.sent.at(-1)).toEqual({ audioStreamEnd: true })
    expect(session.closed).toBe(true)
    expect(stopped).toEqual([true])
  })

  it('closes the late session when connect times out', async () => {
    vi.useFakeTimers()
    try {
      let resolveConnect
      const session = fakeSession()
      const connect = vi.fn().mockImplementation(() => new Promise(resolve => { resolveConnect = () => resolve(session) }))
      const transcriber = new LiveTranscriber({
        createClient: () => ({ live: { connect } }),
        createAudioStack: vi.fn(),
      })
      const start = transcriber.start({ apiKey: 'key', stream: {} })
      const assertion = expect(start).rejects.toThrow('live_connect_timeout')
      await vi.advanceTimersByTimeAsync(9000)
      await assertion
      resolveConnect()
      await vi.waitFor(() => expect(session.closed).toBe(true))
    } finally {
      vi.useRealTimers()
    }
  })

  it('requires an api key and closes the session when audio setup fails', async () => {
    const session = fakeSession()
    const failing = new LiveTranscriber({
      createClient: () => ({ live: { connect: async () => session } }),
      createAudioStack: async () => { throw new Error('no-audio') },
    })
    await expect(failing.start({ apiKey: '', stream: {} })).rejects.toThrow('api_key_missing')
    await expect(failing.start({ apiKey: 'key', stream: {} })).rejects.toThrow('no-audio')
    expect(session.closed).toBe(true)
  })
})
