export const DICTATION_SAMPLE_RATE = 16000
export const TTS_SAMPLE_RATE = 24000
export const TTS_CHUNK_MAX_CHARS = 2000
export const TTS_MAX_CHARS = 12000

export function bytesToBase64(bytes) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export function base64ToBytes(value) {
  const binary = atob(value || '')
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

export function encodeAudioBufferAsWav(audioBuffer) {
  const frameCount = audioBuffer.length
  const channelCount = Math.max(1, audioBuffer.numberOfChannels || 1)
  const pcm = new Int16Array(frameCount)

  for (let frame = 0; frame < frameCount; frame += 1) {
    let mixed = 0
    for (let channel = 0; channel < channelCount; channel += 1) {
      mixed += audioBuffer.getChannelData(channel)[frame] || 0
    }
    const sample = Math.max(-1, Math.min(1, mixed / channelCount))
    pcm[frame] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff)
  }

  const dataLength = pcm.byteLength
  const bytes = new Uint8Array(44 + dataLength)
  const view = new DataView(bytes.buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, audioBuffer.sampleRate, true)
  view.setUint32(28, audioBuffer.sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataLength, true)
  bytes.set(new Uint8Array(pcm.buffer), 44)
  return bytes
}

export async function recordedBlobToWav(blob, {
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
  OfflineAudioContextClass = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext,
  sampleRate = DICTATION_SAMPLE_RATE,
} = {}) {
  if (!AudioContextClass || !OfflineAudioContextClass) throw new Error('audio_context_unavailable')
  const context = new AudioContextClass()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    if (!decoded?.length || !decoded?.duration) throw new Error('empty_audio')
    const outputLength = Math.max(1, Math.ceil(decoded.duration * sampleRate))
    const offline = new OfflineAudioContextClass(1, outputLength, sampleRate)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start(0)
    const rendered = await offline.startRendering()
    return encodeAudioBufferAsWav(rendered)
  } finally {
    await context.close?.()
  }
}

export function normalizeMarkdownForSpeech(markdown, codeSkippedText = 'Code block skipped.') {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ` ${codeSkippedText} `)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[|*_~`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function splitSpeechText(text, maxChars = TTS_CHUNK_MAX_CHARS) {
  const normalized = String(text || '').trim()
  if (!normalized) return []
  const chunks = []
  let remaining = normalized

  while (remaining.length > maxChars) {
    const candidate = remaining.slice(0, maxChars + 1)
    const boundaries = [candidate.lastIndexOf('\n'), candidate.lastIndexOf('. '), candidate.lastIndexOf('! '), candidate.lastIndexOf('? '), candidate.lastIndexOf(' ')]
    const boundary = Math.max(...boundaries)
    const splitAt = boundary >= Math.floor(maxChars * 0.55) ? boundary + 1 : maxChars
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

export function createAudioBufferFromPcm16(audioContext, pcmBytes, sampleRate = TTS_SAMPLE_RATE) {
  const evenLength = pcmBytes.byteLength - (pcmBytes.byteLength % 2)
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, evenLength)
  const audioBuffer = audioContext.createBuffer(1, evenLength / 2, sampleRate)
  const channel = audioBuffer.getChannelData(0)
  for (let index = 0; index < channel.length; index += 1) {
    channel[index] = view.getInt16(index * 2, true) / 0x8000
  }
  return audioBuffer
}
