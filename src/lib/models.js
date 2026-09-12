export const PROVIDERS = Object.freeze({
  GEMINI: 'gemini',
  OPENROUTER: 'openrouter',
  OLLAMA: 'ollama',
})

export const DEFAULT_MODEL = 'gemini-3.1-flash-lite'
export const DEFAULT_PROVIDER = PROVIDERS.GEMINI
export const DEFAULT_OLLAMA_MODEL = 'nemotron-3-ultra'
export const AUTO_MODEL_KEY = 'auto'
export const RETIRED_MODEL_IDS = Object.freeze(['minimax-m3', 'minimax-m3:cloud'])

const geminiModel = (modelId, label, speed, routing = {}) => ({
  key: `${PROVIDERS.GEMINI}:${modelId}`,
  provider: PROVIDERS.GEMINI,
  modelId,
  label,
  ...(speed ? { speed } : {}),
  routing,
  capabilities: {
    supportsImage: true,
    supportsPdf: true,
    supportsUrlContext: true,
  },
})

export const MODEL_CATALOG = Object.freeze([
  geminiModel('gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite', 'fast', { quality: 1, coding: 1 }),
  geminiModel('gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', 'fast', { quality: 2, coding: 2 }),
  geminiModel('gemini-3.6-flash', 'Gemini 3.6 Flash', 'medium', { quality: 3, coding: 3 }),
  geminiModel('gemini-3.7-flash', 'Gemini 3.7 Flash', 'slow', { quality: 4, coding: 4 }),
  geminiModel('gemini-3.8-flash', 'Gemini 3.8 Flash', 'slow', { quality: 5, coding: 5 }),
  {
    key: `${PROVIDERS.OPENROUTER}:openrouter/free`,
    provider: PROVIDERS.OPENROUTER,
    modelId: 'openrouter/free',
    label: 'Free',
    speed: 'medium',
    routing: { quality: 2, coding: 2 },
    capabilities: {
      supportsImage: true,
      supportsPdf: false,
      supportsUrlContext: false,
    },
  },
  {
    key: `${PROVIDERS.OPENROUTER}:nvidia/nemotron-3-super-120b-a12b:free`,
    provider: PROVIDERS.OPENROUTER,
    modelId: 'nvidia/nemotron-3-super-120b-a12b:free',
    label: 'Nemotron 3 Super',
    speed: 'medium',
    routing: { quality: 4, coding: 5 },
    capabilities: {
      supportsImage: false,
      supportsPdf: false,
      supportsUrlContext: false,
    },
  },
  {
    key: `${PROVIDERS.OLLAMA}:gpt-oss:120b`,
    provider: PROVIDERS.OLLAMA,
    modelId: 'gpt-oss:120b',
    label: 'GPT-OSS 120B',
    labelKey: 'chat.model_labels.gpt_oss_120b',
    speed: 'fast',
    routing: { quality: 3, coding: 3 },
    capabilities: {
      supportsImage: false,
      supportsPdf: false,
      supportsUrlContext: false,
    },
  },
  {
    key: `${PROVIDERS.OLLAMA}:nemotron-3-ultra`,
    provider: PROVIDERS.OLLAMA,
    modelId: 'nemotron-3-ultra',
    label: 'Nemotron 3 Ultra',
    labelKey: 'chat.model_labels.nemotron_3_ultra',
    speed: 'slow',
    routing: { quality: 5, coding: 5 },
    capabilities: {
      supportsImage: false,
      supportsPdf: false,
      supportsUrlContext: false,
    },
  },
])

export const MODELS = Object.freeze(MODEL_CATALOG.map(model => model.modelId))
export const MODEL_LABELS = Object.freeze(Object.fromEntries(
  MODEL_CATALOG.map(model => [model.modelId, model.label]),
))
export const MODEL_CAPABILITIES = Object.freeze(Object.fromEntries(
  MODEL_CATALOG.map(model => [model.modelId, Object.freeze({ ...model.capabilities })]),
))

export function getModelDescriptor(modelId, provider = null) {
  return MODEL_CATALOG.find(model => (
    model.modelId === modelId && (!provider || model.provider === provider)
  )) || null
}

export function getProviderForModel(modelId, fallback = DEFAULT_PROVIDER) {
  return getModelDescriptor(modelId)?.provider || fallback
}

export function describeModelFallback(modelId, resolvedModelId, labels = {}) {
  if (typeof resolvedModelId !== 'string' || !resolvedModelId || resolvedModelId === modelId) {
    return null
  }
  const labelFor = id => labels?.[id] || MODEL_LABELS[id] || id
  return { from: labelFor(modelId), to: labelFor(resolvedModelId) }
}

export function isRetiredModelId(modelId) {
  return typeof modelId === 'string' && RETIRED_MODEL_IDS.includes(modelId.trim().toLowerCase())
}

export function isAutoModelKey(value) {
  return typeof value === 'string' && value === AUTO_MODEL_KEY
}

export function getAutoCandidateKeys({ mimeTypes = [], mode = 'chat' } = {}) {
  const normalizedMimes = Array.isArray(mimeTypes) ? mimeTypes : []
  const hasPdf = normalizedMimes.includes('application/pdf')
  const hasImage = normalizedMimes.some(mime => typeof mime === 'string' && mime.startsWith('image/'))
  return MODEL_CATALOG
    .filter(model => {
      if (hasPdf && model.capabilities?.supportsPdf !== true) return false
      if (hasImage && model.capabilities?.supportsImage !== true) return false
      if (mode === 'web' && model.capabilities?.supportsUrlContext !== true) return false
      return true
    })
    .map(model => model.key)
}

export function resolveModelSelection(provider, modelId) {
  if (provider === PROVIDERS.OLLAMA && isRetiredModelId(modelId)) {
    return getModelDescriptor(DEFAULT_OLLAMA_MODEL, PROVIDERS.OLLAMA)
  }
  const exact = getModelDescriptor(modelId, provider)
  if (exact) return exact
  const legacy = getModelDescriptor(modelId)
  if (legacy) return legacy
  return getModelDescriptor(DEFAULT_MODEL, DEFAULT_PROVIDER)
}
