/**
 * HeraAi 1.10.0 — Anahtar seçim servisi (Aşama 13).
 *
 * Plandaki `KeySelectionService` arayüzü: kasa, rotasyon ve sağlık katmanlarını
 * tek giriş noktasında birleştirir.
 *
 * Değişmezler:
 * - Havuz izolasyonu: `provider` neyse yalnız o havuzdan anahtar seçilir.
 * - İstek ortasında anahtar değişmez: `resolveKeyForOperation` bir kez çağrılır,
 *   akış boyunca dönen anahtar kullanılır.
 * - Sağlıksız anahtar (`invalid`, `paused`, süresi dolmamış `cooldown`) seçilmez.
 */

import {
  KEY_USAGE_MODE,
  orderKeysForRequest,
  usageMetadata,
} from './keyRotation'
import { KEY_HEALTH, applyKeyOutcome, isKeyUsable, pauseKey, resumeKey, summarizePool } from './keyHealth'
import { normalizeApiKeyUsageMode } from './syncContract'

/** Tek çağrıda denenecek en fazla anahtar. */
export const MAX_KEY_ATTEMPTS = 3

export function createKeySelectionService({
  vault,
  readUsageMode = async () => KEY_USAGE_MODE.PRIMARY,
  writeUsageMode = async () => {},
  now = () => Date.now(),
  maxAttempts = MAX_KEY_ATTEMPTS,
} = {}) {
  if (!vault?.listKeys) throw new Error('key_service_vault_missing')

  /** Mod okunurken hata olursa güvenli varsayılan `primary` olur. */
  async function mod() {
    try {
      return normalizeApiKeyUsageMode(await readUsageMode())
    } catch {
      return KEY_USAGE_MODE.PRIMARY
    }
  }

  /**
   * İstek için anahtar rezerve eder.
   * Dönen kayıt akış boyunca sabittir; `recordSuccess` / `recordFailure` ile
   * sonuç bildirilir.
   */
  async function resolveKeyForOperation({ provider, model = null, operationId = null, excludeIds = [] } = {}) {
    if (!provider) throw new Error('key_provider_missing')
    const kullanimModu = await mod()
    const zaman = now()
    const hepsi = await vault.listKeys(provider)
    const disarida = new Set((excludeIds || []).map(String))

    const uygun = []
    for (const kayit of hepsi) {
      if (disarida.has(String(kayit.id))) continue
      if (!isKeyUsable(kayit, { now: zaman })) continue
      uygun.push(kayit)
    }

    if (uygun.length === 0) {
      const beklemede = hepsi.filter(k => k.cooldownUntil && k.cooldownUntil > zaman)
      return {
        ok: false,
        reason: hepsi.length === 0 ? 'no_keys' : 'all_unavailable',
        provider,
        operationId,
        allInCooldown: beklemede.length === hepsi.length && hepsi.length > 0,
        earliestCooldownEnd: beklemede.length > 0
          ? Math.min(...beklemede.map(k => k.cooldownUntil))
          : null,
      }
    }

    // `orderKeysForRequest` metadata üzerinde çalışır; ham anahtar ayrıca çözülür.
    const sirali = orderKeysForRequest(uygun, kullanimModu).slice(0, Math.max(1, maxAttempts))
    const secilen = sirali[0]

    return {
      ok: true,
      provider,
      model,
      operationId,
      mode: kullanimModu,
      keyId: secilen.id,
      isPrimary: Boolean(secilen.isPrimary),
      reservedAt: zaman,
      /** Sıradaki denemeler için yedek sıra (aynı havuzdan). */
      fallbackIds: sirali.slice(1).map(k => k.id),
      /** Akış boyunca kullanılacak ham anahtar; her çağrıda yeniden çözülür. */
      readKey: async () => vault.getRawKey(provider, secilen.id),
    }
  }

  /** Ham anahtarla birlikte rezervasyon (çağıran taraf için kısayol). */
  async function reserveRawKey(options) {
    const rezervasyon = await resolveKeyForOperation(options)
    if (!rezervasyon.ok) return rezervasyon
    return { ...rezervasyon, key: await rezervasyon.readKey() }
  }

  /** Başarılı istek: sayaç ve bekleme sıfırlanır. */
  async function recordSuccess({ provider, keyId } = {}) {
    if (!provider || !keyId) throw new Error('key_record_missing')
    const meta = usageMetadata({ now: now(), success: true })
    await vault.updateKeyMetadata(provider, keyId, meta)
    return meta
  }

  /** Başarısız istek: hata sınıflandırılır, bekleme kurulur. */
  async function recordFailure({ provider, keyId, errorType, status, retryAfterMs, message, modelScoped } = {}) {
    if (!provider || !keyId) throw new Error('key_record_missing')
    const mevcut = (await vault.listKeys(provider)).find(k => String(k.id) === String(keyId)) || {}
    const yeni = applyKeyOutcome(mevcut, {
      success: false,
      status,
      errorType,
      message,
      modelScoped,
      retryAfter: retryAfterMs !== undefined && retryAfterMs !== null ? retryAfterMs / 1000 : null,
      now: now(),
    })
    await vault.updateKeyMetadata(provider, keyId, {
      status: yeni.status,
      lastUsedAt: yeni.lastUsedAt,
      lastErrorAt: yeni.lastErrorAt,
      lastErrorType: yeni.lastErrorType,
      cooldownUntil: yeni.cooldownUntil,
      failCount: yeni.failCount,
    })
    return yeni
  }

  /** Kullanıcı anahtarı duraklatır. */
  async function pause(provider, keyId) {
    const mevcut = (await vault.listKeys(provider)).find(k => String(k.id) === String(keyId)) || {}
    const yeni = pauseKey(mevcut, { now: now() })
    await vault.updateKeyMetadata(provider, keyId, { status: yeni.status })
    return yeni
  }

  /** Duraklatmayı kaldırır. */
  async function resume(provider, keyId) {
    const mevcut = (await vault.listKeys(provider)).find(k => String(k.id) === String(keyId)) || {}
    const yeni = resumeKey(mevcut, { now: now() })
    await vault.updateKeyMetadata(provider, keyId, {
      status: yeni.status,
      cooldownUntil: null,
      failCount: 0,
    })
    return yeni
  }

  /** Global kullanım modunu yazar. */
  async function setGlobalStrategy(strategy) {
    const normalize = normalizeApiKeyUsageMode(strategy)
    await writeUsageMode(normalize)
    return normalize
  }

  /** Kullanım modunu okur. */
  async function getStrategy() {
    return mod()
  }

  /** Havuzun sağlık özeti (arayüz rozetleri). */
  async function summarize(provider) {
    const kayitlar = await vault.listKeys(provider)
    return summarizePool(kayitlar, { now: now() })
  }

  /** Rotasyona girebilecek anahtar sırası (arayüz önizlemesi). */
  async function previewOrder(provider) {
    const kayitlar = await vault.listKeys(provider)
    const kullanimModu = await mod()
    return orderKeysForRequest(kayitlar, kullanimModu).map(k => ({
      id: k.id,
      status: k.status || KEY_HEALTH.UNTESTED,
      lastUsedAt: k.lastUsedAt ?? null,
      isPrimary: Boolean(k.isPrimary),
    }))
  }

  return {
    resolveKeyForOperation,
    reserveRawKey,
    recordSuccess,
    recordFailure,
    pauseKey: pause,
    resumeKey: resume,
    setGlobalStrategy,
    getStrategy,
    summarize,
    previewOrder,
  }
}

/** Servis arayüzünün tanıtımı (test ve dokümantasyon). */
export function describeKeySelectionService() {
  return {
    methods: [
      'resolveKeyForOperation',
      'recordSuccess',
      'recordFailure',
      'pauseKey',
      'resumeKey',
      'setGlobalStrategy',
      'getStrategy',
    ],
    maxAttempts: MAX_KEY_ATTEMPTS,
    poolIsolation: true,
    midStreamSwitch: false,
  }
}
