import { describe, expect, it } from 'vitest'

import {
  API_KEY_USAGE_MODES,
  ATTACHMENT_SYNC_POLICY,
  MERGE_STRATEGY,
  MESSAGE_FIELD_CONTRACT,
  SESSION_FIELD_CONTRACT,
  SESSION_SYNC_POLICIES,
  SYNC_CLASS,
  SYNC_SCHEMA_VERSION,
  classifyStorageKey,
  describeSyncContract,
  getKeysByClass,
  getMergeStrategy,
  getNonSyncedKeys,
  getSyncedKeys,
  isLocalOnlyKey,
  isSyncedKey,
  normalizeApiKeyUsageMode,
  normalizeSessionSyncPolicy,
  usesTombstone,
} from './syncContract'

/**
 * Kodun gerçekten yazdığı depolama anahtarları. Kaynak tarafında yeni bir
 * anahtar kullanılmaya başlanır da sözleşmeye satırı eklenmezse bu liste ile
 * `getSyncedKeys()`/`getNonSyncedKeys()` arasındaki fark testi kırar.
 */
const KEYS_USED_IN_CODE = [
  // App.jsx initialize() + SettingsPanel.handleSave()
  'theme',
  'startupBehavior',
  'systemInstruction',
  'systemInstructionDefaultVersion',
  'chatHistory',
  'sessions',
  'activeSessionId',
  'activeGeneration',
  'customPrimaryColor',
  'language',
  'showSources',
  'selectedText',
  'selectedModel',
  'selectedProvider',
  'modelSelectionMode',
  // background/service_worker.js (bağlam menüsü)
  'pendingPageUrl',
  // lib/keyManager.js
  'geminiApiKeys',
  'tavilyApiKeys',
  'openRouterApiKeys',
  'ollamaApiKeys',
  // lib/stats.js
  'stats',
  // lib/autoSyncScheduler.js + lib/cloudSyncCoordinator.js (otomatik eşitleme)
  'syncAutoIntervalMinutes',
  'syncUsage',
  // App.jsx yazı alanı yükseklik tercihi
  'composerMaxHeight',
]

const SOZLESME = describeSyncContract()
const TUM_ANAHTARLAR = [
  ...SOZLESME.settings,
  ...SOZLESME.entities,
  ...SOZLESME.stats,
  ...SOZLESME.localOnly,
  ...SOZLESME.excluded,
]

describe('syncContract sınıflandırması', () => {
  it('koddaki her depolama anahtarı sözleşmede tanımlıdır', () => {
    const tanimsiz = KEYS_USED_IN_CODE.filter(
      key => !TUM_ANAHTARLAR.includes(key),
    )
    expect(tanimsiz).toEqual([])
  })

  it('hiçbir anahtar birden fazla sınıfta yer almaz', () => {
    const hepsi = describeSyncContract()
    const tumu = [
      ...hepsi.settings,
      ...hepsi.entities,
      ...hepsi.stats,
      ...hepsi.localOnly,
      ...hepsi.excluded,
    ]
    expect(new Set(tumu).size).toBe(tumu.length)
  })

  it('bilinmeyen anahtar güvenli varsayılanla eşitlenmez', () => {
    expect(classifyStorageKey('gelecekteEklenenBirAyar')).toBe(SYNC_CLASS.EXCLUDED)
    expect(isSyncedKey('gelecekteEklenenBirAyar')).toBe(false)
    expect(isLocalOnlyKey('gelecekteEklenenBirAyar')).toBe(false)
    expect(getMergeStrategy('gelecekteEklenenBirAyar')).toBe(MERGE_STRATEGY.NONE)
    expect(usesTombstone('gelecekteEklenenBirAyar')).toBe(false)
  })

  it.each([
    ['theme', SYNC_CLASS.SETTING],
    ['systemInstructionDefaultVersion', SYNC_CLASS.SETTING],
    ['sessions', SYNC_CLASS.ENTITY],
    ['geminiApiKeys', SYNC_CLASS.ENTITY],
    ['ollamaApiKeys', SYNC_CLASS.ENTITY],
    ['stats', SYNC_CLASS.STATS],
    ['activeSessionId', SYNC_CLASS.LOCAL_ONLY],
    ['selectedText', SYNC_CLASS.LOCAL_ONLY],
    ['pendingPageUrl', SYNC_CLASS.LOCAL_ONLY],
    ['activeGeneration', SYNC_CLASS.LOCAL_ONLY],
    ['chatHistory', SYNC_CLASS.EXCLUDED],
  ])('%s -> %s', (key, beklenen) => {
    expect(classifyStorageKey(key)).toBe(beklenen)
  })

  it('sınıf ile birleştirme stratejisi tutarlıdır', () => {
    const beklenen = {
      [SYNC_CLASS.SETTING]: MERGE_STRATEGY.LAST_WRITE_WINS,
      [SYNC_CLASS.ENTITY]: MERGE_STRATEGY.ENTITY_UNION,
      [SYNC_CLASS.STATS]: MERGE_STRATEGY.STATS_SUM,
      [SYNC_CLASS.LOCAL_ONLY]: MERGE_STRATEGY.NONE,
      [SYNC_CLASS.EXCLUDED]: MERGE_STRATEGY.NONE,
    }
    for (const key of TUM_ANAHTARLAR) {
      expect(getMergeStrategy(key)).toBe(beklenen[classifyStorageKey(key)])
    }
  })
})

describe('syncContract kapsamı', () => {
  it('ayarlar, koleksiyonlar ve istatistikler eşitlenen taraftadır', () => {
    expect(isSyncedKey('theme')).toBe(true)
    expect(isSyncedKey('sessions')).toBe(true)
    expect(isSyncedKey('stats')).toBe(true)
  })

  it('cihaza özel anahtarlar eşitlenmez', () => {
    for (const key of getKeysByClass(SYNC_CLASS.LOCAL_ONLY)) {
      expect(isSyncedKey(key)).toBe(false)
      expect(isLocalOnlyKey(key)).toBe(true)
    }
  })

  it('eşitlenen ve eşitlenmeyen kümeler tüm anahtarları bölüşür', () => {
    const hepsi = getSyncedKeys().length + getNonSyncedKeys().length
    expect(hepsi).toBe(TUM_ANAHTARLAR.length)
    expect(getSyncedKeys().filter(key => getNonSyncedKeys().includes(key))).toEqual([])
  })

  it('aktif sohbet seçimi ve canlı üretim cihazda kalır', () => {
    expect(isLocalOnlyKey('activeSessionId')).toBe(true)
    expect(isLocalOnlyKey('activeGeneration')).toBe(true)
  })

  it('v1 kalıntısı eşitleme dışıdır', () => {
    expect(classifyStorageKey('chatHistory')).toBe(SYNC_CLASS.EXCLUDED)
    expect(isSyncedKey('chatHistory')).toBe(false)
  })

  it('sohbet ve anahtar koleksiyonları tombstone taşır', () => {
    expect(usesTombstone('sessions')).toBe(true)
    expect(usesTombstone('geminiApiKeys')).toBe(true)
    expect(usesTombstone('stats')).toBe(false)
  })

  it('şema sürümü tanımlıdır', () => {
    expect(SYNC_SCHEMA_VERSION).toBe(1)
  })
})

describe('syncContract alan sözleşmeleri', () => {
  it('sohbet kaydı alanları dışa aktarma şemasıyla uyumludur', () => {
    const alanlar = Object.values(SESSION_FIELD_CONTRACT).flat()
    expect(alanlar).toContain('id')
    expect(alanlar).toContain('isTitleCustom')
    expect(alanlar).toContain('isStarred')
    expect(alanlar).toContain('syncPolicy')
  })

  it('mesaj alanları sağlayıcı/model kaynağını taşır', () => {
    const alanlar = Object.values(MESSAGE_FIELD_CONTRACT).flat()
    expect(alanlar).toContain('model')
    expect(alanlar).toContain('provider')
    expect(alanlar).toContain('resolvedModel')
    expect(alanlar).toContain('attachments')
  })

  it('ek politikasında yalnız metadata eşitlenir', () => {
    expect(ATTACHMENT_SYNC_POLICY.maxSyncBytes).toBe(0)
    expect(ATTACHMENT_SYNC_POLICY.binarySynced).toBe(false)
    expect(ATTACHMENT_SYNC_POLICY.metadataSynced).toBe(true)
    expect(ATTACHMENT_SYNC_POLICY.store).toBe('heraai-attachments')
    expect(ATTACHMENT_SYNC_POLICY.missingMetadata).toContain('availability')
  })
})

describe('syncContract değer doğrulama', () => {
  it('anahtar kullanım modu yalnız bilinen iki değeri kabul eder', () => {
    expect(API_KEY_USAGE_MODES).toEqual(['primary', 'balanced_rotation'])
    expect(normalizeApiKeyUsageMode('balanced_rotation')).toBe('balanced_rotation')
    expect(normalizeApiKeyUsageMode('primary')).toBe('primary')
    expect(normalizeApiKeyUsageMode('rastgele')).toBe('primary')
    expect(normalizeApiKeyUsageMode(undefined)).toBe('primary')
  })

  it('sohbet eşitleme politikası bilinmeyen değerde güvenli tarafa düşer', () => {
    expect(SESSION_SYNC_POLICIES).toEqual(['synced', 'local_only'])
    expect(normalizeSessionSyncPolicy('local_only')).toBe('local_only')
    expect(normalizeSessionSyncPolicy('synced')).toBe('synced')
    expect(normalizeSessionSyncPolicy('baska')).toBe('synced')
  })
})
