import { GoogleGenAI, Modality } from '@google/genai'

import { bytesToBase64 } from './audioUtils'

export const LIVE_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live'
export const LIVE_SAMPLE_RATE = 16000
const LIVE_CONNECT_TIMEOUT_MS = 8000
const LIVE_FINISH_GRACE_MS = 1500

export function supportsLiveDictation() {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext
  return Boolean(AudioContextClass) && Boolean(navigator?.mediaDevices?.getUserMedia)
}

export function floatTo16BitPCM(samples) {
  const output = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] || 0))
    output[index] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
  }
  return output
}

// Streaming display join: space-separated (unlike the batch path, which joins
// chunk transcripts with newlines). Empty-safe on every argument.
export function appendLiveText(current, text) {
  const safeCurrent = typeof current === 'string' ? current : ''
  const safeText = typeof text === 'string' ? text.trim() : ''
  if (!safeText) return safeCurrent
  if (!safeCurrent) return safeText
  const needsSpace = /[\s(["'“‘]$/.test(safeCurrent) ? '' : ' '
  return `${safeCurrent}${needsSpace}${safeText}`
}

export function createLiveClient(apiKey) {
  return new GoogleGenAI({ apiKey })
}

function withTimeout(promise, ms, onTimeout) {
  let timerId = null
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error('live_connect_timeout')), ms)
  })
  return Promise.race([promise, timeout]).then(
    result => { clearTimeout(timerId); return result },
    error => {
      clearTimeout(timerId)
      // A late-resolving session must never leak: close it when it arrives.
      Promise.resolve(promise).then(session => {
        try { session?.close?.() } catch { /* ignored */ }
      }, () => undefined)
      onTimeout?.()
      throw error
    },
  )
}

// The processor ships as a verbatim extension asset (public/), because
// AudioWorklet.addModule rejects data:/blob: URLs and the file must resolve
// at runtime under chrome-extension://.
function workletUrl() {
  if (typeof chrome !== 'undefined' && chrome?.runtime?.getURL) {
    return chrome.runtime.getURL('pcmCaptureProcessor.js')
  }
  return new URL('./pcmCaptureProcessor.js', import.meta.url)
}

// Default browser audio stack: mic -> 16 kHz PCM Float32 chunks. Falls back to
// ScriptProcessor when AudioWorklet is unavailable. Returns { sampleRate, stop }.
export async function defaultAudioStack(stream, onPcm) {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext
  if (!AudioContextClass) throw new Error('audio_context_unavailable')
  const context = new AudioContextClass({ sampleRate: LIVE_SAMPLE_RATE })
  const source = context.createMediaStreamSource(stream)
  let node
  let detach = () => undefined
  if (context.audioWorklet) {
    await context.audioWorklet.addModule(workletUrl())
    node = new AudioWorkletNode(context, 'hera-pcm-capture')
    node.port.onmessage = event => onPcm(event.data)
    detach = () => { node.port.onmessage = null }
  } else {
    node = context.createScriptProcessor(4096, 1, 1)
    node.onaudioprocess = event => onPcm(event.inputBuffer.getChannelData(0).slice(0))
    detach = () => { node.onaudioprocess = null }
  }
  source.connect(node)
  // The node emits silence; connecting keeps the graph alive in every browser.
  node.connect(context.destination)
  return {
    sampleRate: context.sampleRate || LIVE_SAMPLE_RATE,
    stop: async () => {
      try { detach() } catch { /* ignored */ }
      try { source.disconnect() } catch { /* ignored */ }
      try { node.disconnect() } catch { /* ignored */ }
      try { await context.close() } catch { /* ignored */ }
    },
  }
}

export class LiveTranscriber {
  constructor({
    createClient = createLiveClient,
    createAudioStack = defaultAudioStack,
    languageCodes = [],
    onInterim = () => undefined,
    onFinal = () => undefined,
    onError = () => undefined,
    onOpen = () => undefined,
    onClose = () => undefined,
  } = {}) {
    this.createClient = createClient
    this.createAudioStack = createAudioStack
    this.languageCodes = languageCodes
    this.onInterim = onInterim
    this.onFinal = onFinal
    this.onError = onError
    this.onOpen = onOpen
    this.onClose = onClose
    this.session = null
    this.audio = null
    this.sampleRate = LIVE_SAMPLE_RATE
    this.settled = false
  }

  handleMessage(message) {
    const content = message?.serverContent
    if (!content) return
    const interim = content.interimInputTranscription?.text
    if (typeof interim === 'string' && interim) this.onInterim(interim)
    const finalized = content.inputTranscription?.text
    if (typeof finalized === 'string' && finalized.trim()) this.onFinal(finalized.trim())
  }

  async start({ apiKey, stream }) {
    if (!apiKey) throw new Error('api_key_missing')
    if (!stream) throw new Error('empty_audio')
    const client = this.createClient(apiKey)
    const session = await withTimeout(client.live.connect({
      model: LIVE_TRANSCRIBE_MODEL,
      config: {
        responseModalities: [Modality.TEXT],
        inputAudioTranscription: { languageCodes: [...this.languageCodes] },
      },
      callbacks: {
        onopen: () => this.onOpen(),
        onmessage: message => this.handleMessage(message),
        onerror: event => this.onError(event),
        onclose: event => this.onClose(event),
      },
    }), LIVE_CONNECT_TIMEOUT_MS)
    this.session = session
    try {
      this.audio = await this.createAudioStack(stream, chunk => this.sendPcm(chunk))
      this.sampleRate = this.audio.sampleRate || LIVE_SAMPLE_RATE
    } catch (error) {
      try { session.close() } catch { /* ignored */ }
      this.session = null
      throw error
    }
    return { sampleRate: this.sampleRate }
  }

  sendPcm(chunk) {
    if (!this.session || !chunk?.length) return
    try {
      const pcm16 = floatTo16BitPCM(chunk)
      this.session.sendRealtimeInput({
        audio: {
          data: bytesToBase64(new Uint8Array(pcm16.buffer)),
          mimeType: `audio/pcm;rate=${this.sampleRate}`,
        },
      })
    } catch {
      // A dead socket must never crash capture; close is handled by callbacks.
    }
  }

  async finish({ graceMs = LIVE_FINISH_GRACE_MS } = {}) {
    if (this.settled) return
    this.settled = true
    try {
      this.session?.sendRealtimeInput?.({ audioStreamEnd: true })
    } catch { /* ignored */ }
    if (graceMs > 0) await new Promise(resolve => setTimeout(resolve, graceMs))
    await this.dispose()
  }

  async abort() {
    if (this.settled) return
    this.settled = true
    await this.dispose()
  }

  async dispose() {
    const session = this.session
    this.session = null
    try { session?.close?.() } catch { /* ignored */ }
    const audio = this.audio
    this.audio = null
    try { await audio?.stop?.() } catch { /* ignored */ }
  }
}
