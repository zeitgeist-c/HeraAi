// AudioWorklet processor: accumulates mic samples and posts 16 kHz PCM chunks.
// This file runs inside AudioWorkletGlobalScope (loaded via addModule), so it
// must stay dependency-free. The registration is guarded so unit tests can
// import the file without a worklet environment.
const HERAAI_PCM_CHUNK_SAMPLES = 2048

class HeraPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(HERAAI_PCM_CHUNK_SAMPLES)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs?.[0]?.[0]
    if (channel && channel.length) {
      let offset = 0
      while (offset < channel.length) {
        const room = HERAAI_PCM_CHUNK_SAMPLES - this.filled
        const take = Math.min(room, channel.length - offset)
        this.buffer.set(channel.subarray(offset, offset + take), this.filled)
        this.filled += take
        offset += take
        if (this.filled >= HERAAI_PCM_CHUNK_SAMPLES) {
          this.port.postMessage(this.buffer.slice())
          this.filled = 0
        }
      }
    }
    return true
  }
}

if (typeof registerProcessor !== 'undefined') {
  registerProcessor('hera-pcm-capture', HeraPcmCapture)
}
