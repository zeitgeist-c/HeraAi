export const PROVIDERS = Object.freeze({
  GEMINI: 'gemini',
  OPENROUTER: 'openrouter',
})

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite'
export const DEFAULT_PROVIDER = PROVIDERS.GEMINI
export const AUTO_MODEL_KEY = 'auto'
// Older ids this system no longer offers. Sessions that still carry one fall
// back to the default instead of failing; see resolveModelSelection and
// modelMigration.
export const RETIRED_MODEL_IDS = Object.freeze([
  'minimax-m3',
  'minimax-m3:cloud',
  'nemotron-3-ultra',
  'qwen/qwen3.8-27b:free',
  'nex-agi/nex-n2.5-pro:free',
  'gemini-3.1-flash-lite',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'gpt-oss:120b',
  'nemotron-3-super',
  'gemma4:31b',
])

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

// Fixed catalog (Kasim 2026 dogrulamasi). Bu liste elle degisir; ayarlarda
// model secimi yok. Aylik kontrol yeni/olen modelleri raporlar, degisiklik
// onayla uygulanir.
export const MODEL_CATALOG = Object.freeze([
  geminiModel('gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', 'fast', { quality: 2, coding: 2 }),
  geminiModel('gemini-3.6-flash', 'Gemini 3.6 Flash', 'medium', { quality: 3, coding: 3 }),
  geminiModel('gemini-4-hydrogen', 'Gemini 4 Hydrogen', 'slow', { quality: 5, coding: 4 }),
  {
    key: `${PROVIDERS.OPENROUTER}:nvidia/nemotron-3.5-lightning:free`,
    provider: PROVIDERS.OPENROUTER,
    modelId: 'nvidia/nemotron-3.5-lightning:free',
    label: 'Nemotron 3.5 Lightning',
    speed: 'fast',
    routing: { quality: 3, coding: 3 },
    capabilities: {
      // Akil yuruterek cevap verir; kisa token limiti cevabi keser.
      supportsImage: false,
      supportsPdf: false,
      supportsUrlContext: false,
    },
  },
  {
    key: `${PROVIDERS.OPENROUTER}:nvidia/nemotron-3.5-super-vl:free`,
    provider: PROVIDERS.OPENROUTER,
    modelId: 'nvidia/nemotron-3.5-super-vl:free',
    label: 'Nemotron 3.5 Super VL',
    speed: 'medium',
    routing: { quality: 4, coding: 4 },
    capabilities: {
      supportsImage: true,
      supportsPdf: false,
      supportsUrlContext: false,
    },
  },
  {
    key: `${PROVIDERS.OPENROUTER}:inclusionai/ling-3.2-flash:free`,
    provider: PROVIDERS.OPENROUTER,
    modelId: 'inclusionai/ling-3.2-flash:free',
    label: 'Ling 3.2 Flash',
    speed: 'fast',
    routing: { quality: 2, coding: 2 },
    capabilities: {
      supportsImage: true,
      supportsPdf: false,
      supportsUrlContext: false,
    },
  },
])

export const MODELS = Object.freeze(MODEL_CATALOG.map(model => model.modelId))
// OpenRouter requests may ONLY target these ids — see getOpenRouterFallbackModel.
export const OPENROUTER_MODEL_IDS = Object.freeze(
  MODEL_CATALOG.filter(model => model.provider === PROVIDERS.OPENROUTER).map(model => model.modelId),
)
export const MODEL_LABELS = Object.freeze({
  // Sessions saved by earlier versions may carry the removed `openrouter/free`
  // router id as their resolved model; keep a readable label for that badge.
  'openrouter/free': 'Free',
  ...Object.fromEntries(MODEL_CATALOG.map(model => [model.modelId, model.label])),
})
export const MODEL_CAPABILITIES = Object.freeze(Object.fromEntries(
  MODEL_CATALOG.map(model => [model.modelId, Object.freeze({ ...model.capabilities })]),
))

// Fixed catalog: user preferences no longer select models. The argument is
// accepted so older call sites keep working, but the runtime catalog is
// always the fixed list above.
let runtimeCatalog = MODEL_CATALOG
export function configureModelCatalog() {
  runtimeCatalog = MODEL_CATALOG
  return runtimeCatalog
}

export function getRuntimeModelCatalog() { return runtimeCatalog }

export function modelAllowsKey(modelId, provider, keyId) {
  const model = getModelDescriptor(modelId, provider)
  return !model?.sourceKeyIds || model.sourceKeyIds.includes(keyId)
}

export function getModelDescriptor(modelId, provider = null) {
  return runtimeCatalog.find(model => (
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
  return runtimeCatalog
    .filter(model => {
      if (hasPdf && model.capabilities?.supportsPdf !== true) return false
      if (hasImage && model.capabilities?.supportsImage !== true) return false
      if (mode === 'web' && model.capabilities?.supportsUrlContext !== true) return false
      return true
    })
    .map(model => model.key)
}

export function getOpenRouterFallbackModel(modelId, { hasImage = false } = {}) {
  const candidates = runtimeCatalog
    .filter(model => model.provider === PROVIDERS.OPENROUTER)
    .filter(model => (hasImage ? model.capabilities?.supportsImage === true : true))
    .map(model => model.modelId)
  if (candidates.length === 0) return null
  const index = candidates.indexOf(modelId)
  const fallback = candidates[(index + 1) % candidates.length]
  return fallback === modelId ? null : fallback
}

export function resolveModelSelection(provider, modelId) {
  const exact = getModelDescriptor(modelId, provider)
  if (exact) return exact
  const legacy = getModelDescriptor(modelId)
  if (legacy) return legacy
  return getModelDescriptor(DEFAULT_MODEL, DEFAULT_PROVIDER) || runtimeCatalog[0] || null
}
