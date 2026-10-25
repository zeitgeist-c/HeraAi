import { MODEL_CATALOG, getModelDescriptor } from './models'

export const MODEL_PREFERENCES_KEY = 'modelPreferences'
const PROVIDER_URLS = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
  openrouter: 'https://openrouter.ai/api/v1/models/user',
  ollama: 'https://ollama.com/api/tags',
}

export function normalizeDiscoveredModel(provider, item, sourceKeyId) {
  const modelId = provider === 'gemini' ? item.name?.replace(/^models\//, '')
    : provider === 'openrouter' ? item.id : item.name || item.model
  if (typeof modelId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/.test(modelId)) return null
  if (provider === 'openrouter' && ['openrouter/free', 'openrouter/auto'].includes(modelId)) return null
  if (provider === 'gemini' && (!item.supportedGenerationMethods?.includes('generateContent')
    || /(?:image|tts|audio|robotics)/i.test(modelId))) return null
  if (provider === 'openrouter' && item.architecture?.output_modalities
    && !item.architecture.output_modalities.includes('text')) return null
  const known = MODEL_CATALOG.find(model => model.provider === provider && model.modelId === modelId)
    || getModelDescriptor(modelId, provider)
  return {
    key: `${provider}:${modelId}`, provider, modelId,
    discovered: true,
    label: String(item.displayName || (provider === 'openrouter' && item.name) || known?.label || modelId).slice(0, 160),
    sourceKeyIds: [sourceKeyId],
    capabilities: {
      // Unknown Gemini/Ollama modalities stay conservative; never infer vision from a name.
      supportsImage: provider === 'openrouter' ? item.architecture?.input_modalities?.includes('image') === true : known?.capabilities?.supportsImage === true,
      supportsPdf: provider === 'gemini' && known?.capabilities?.supportsPdf === true,
      supportsUrlContext: provider === 'gemini' && known?.capabilities?.supportsUrlContext === true,
    },
    contextLength: Number(item.context_length || item.inputTokenLimit) || null,
    pricing: provider === 'openrouter' ? {
      prompt: item.pricing?.prompt ?? null, completion: item.pricing?.completion ?? null,
    } : null,
    routing: known?.routing || {},
  }
}

export async function discoverModels(provider, rawKey, keyId, { fetcher = fetch, signal } = {}) {
  if (!PROVIDER_URLS[provider] || !rawKey || !keyId) throw new Error('model_discovery_invalid')
  const models = []
  const seenPages = new Set()
  let pageToken = ''
  let offset = 0
  for (let page = 0; page < 50; page += 1) {
    const url = new URL(PROVIDER_URLS[provider])
    if (provider === 'gemini') {
      url.searchParams.set('pageSize', '1000')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
    }
    if (provider === 'openrouter') {
      url.searchParams.set('offset', String(offset))
      url.searchParams.set('limit', '100')
    }
    const response = await fetcher(url.href, {
      headers: provider === 'gemini' ? { 'x-goog-api-key': rawKey } : { Authorization: `Bearer ${rawKey}` },
      signal: signal || AbortSignal.timeout(20_000), credentials: 'omit', redirect: 'error',
    })
    if (!response.ok) throw new Error(`model_discovery_http_${response.status}`)
    const data = await response.json()
    const items = provider === 'openrouter' ? data.data : data.models
    if (!Array.isArray(items)) throw new Error('model_discovery_invalid_response')
    for (const item of items) {
      const model = normalizeDiscoveredModel(provider, item, keyId)
      if (model) models.push(model)
    }
    if (provider === 'ollama' || (provider === 'openrouter' && items.length < 100)) return models
    if (provider === 'openrouter') offset += items.length
    else {
      pageToken = data.nextPageToken || ''
      if (!pageToken) return models
      if (seenPages.has(pageToken)) throw new Error('model_discovery_pagination')
      seenPages.add(pageToken)
    }
  }
  throw new Error('model_discovery_too_many_pages')
}

export function mergeDiscoveryResults(results) {
  const models = new Map()
  for (const list of results) for (const model of list) {
    const previous = models.get(model.key)
    models.set(model.key, { ...model, sourceKeyIds: [...new Set([...(previous?.sourceKeyIds || []), ...model.sourceKeyIds])] })
  }
  return [...models.values()]
}
