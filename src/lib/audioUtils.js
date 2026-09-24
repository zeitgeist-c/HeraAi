export const DICTATION_SAMPLE_RATE = 16000
export const DICTATION_CHUNK_SECONDS = 30

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

// Uzun dikte kayitlarini modele parca parca gondermek icin: 44 baytlik WAV
// basligini koruyup PCM verisini sabit uzunlukta dilimlere boler. Boylece her
// istek kucuk kalir ve tek bir 5xx/400 tum dikteyi oldurmez.
export function splitWavIntoChunks(wavBytes, {
  sampleRate = DICTATION_SAMPLE_RATE,
  chunkSeconds = DICTATION_CHUNK_SECONDS,
} = {}) {
  const WAV_HEADER_BYTES = 44
  const bytes = wavBytes instanceof Uint8Array ? wavBytes : new Uint8Array(wavBytes || [])
  if (bytes.byteLength <= WAV_HEADER_BYTES) return [bytes]
  const chunkBytes = Math.max(2, Math.floor(sampleRate * chunkSeconds) * 2)
  const dataLength = bytes.byteLength - WAV_HEADER_BYTES
  if (dataLength <= chunkBytes) return [bytes]

  const header = bytes.subarray(0, WAV_HEADER_BYTES)
  const chunks = []
  for (let offset = 0; offset < dataLength; offset += chunkBytes) {
    const end = Math.min(dataLength, offset + chunkBytes)
    const sliceLength = end - offset
    const chunk = new Uint8Array(WAV_HEADER_BYTES + sliceLength)
    chunk.set(header, 0)
    chunk.set(bytes.subarray(WAV_HEADER_BYTES + offset, WAV_HEADER_BYTES + end), WAV_HEADER_BYTES)
    const view = new DataView(chunk.buffer)
    view.setUint32(4, 36 + sliceLength, true)
    view.setUint32(40, sliceLength, true)
    chunks.push(chunk)
  }
  return chunks
}

