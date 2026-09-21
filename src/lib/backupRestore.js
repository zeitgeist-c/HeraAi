/**
 * HeraAi 1.10.0 — Yedi günlük geri yükleme ve dışa aktarma (Aşama 12).
 *
 * İki çıktı ve bir geri dönüş mekanizması:
 *
 * - **Hesap Kurtarma Kiti** (`heraai-recovery-kit.txt`): maskelenmiş hesap,
 *   kurtarma kodu, anahtar sürümü ve acil durum talimatları. API anahtarı ve
 *   sohbet içeriği **taşımaz**.
 * - **Şifreli Tam Veri Yedeği** (`.heraai-backup`): sohbetler, şifreli API
 *   kasası, ayarlar ve istatistiklerin `backupKey` ile AES-256-GCM şifrelenmiş
 *   JSON paketi. Sıkıştırma destekleniyorsa gzip uygulanır.
 * - **Geri dönüş noktaları**: son 7 gün için günde en fazla bir nokta; geri
 *   yükleme geçmiş `revisions` dokümanlarından istenen andaki durumu hesaplar
 *   ve yeni bir güncel sürüm olarak uygular.
 */

import {
  CLOUD_SCHEMA_VERSION,
  CRYPTO_VERSION,
  buildRevisionId,
  compareEntityVersions,
  isRevisionExpired,
  parseEntityVersion,
} from './syncModel'
import { bytesToBase64, decryptJson, encryptJson } from './syncCrypto'
import { maskAccount } from './accountUiState'

/** Yedek dosya uzantısı. */
export const BACKUP_EXTENSION = '.heraai-backup'

/** Yedek paket biçimi sürümü. */
export const BACKUP_FORMAT_VERSION = 1

/** Geri dönüş noktası saklama süresi (gün). */
export const RESTORE_POINT_DAYS = 7

/** Kurtarma kiti dosya adı. */
export const RECOVERY_KIT_FILENAME = 'heraai-recovery-kit.txt'

const GUN_MS = 24 * 60 * 60 * 1000

function sayi(deger) {
  const n = Number(deger)
  return Number.isFinite(n) ? n : null
}

/** Yerel gün anahtarı (`YYYY-MM-DD`); bulut yollarıyla aynı biçim. */
export function dateKeyFor(value) {
  const d = value instanceof Date ? value : new Date(value)
  const pad = v => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Son `days` gün için geri dönüş noktası anahtarları (en yeni önce).
 * Günde en fazla bir nokta: aynı gün anahtarı tekrar üretilmez.
 */
export function planRestorePoints({ now = Date.now(), days = RESTORE_POINT_DAYS } = {}) {
  // `days: 0` açıkça verildiğinde varsayılana düşmemeli; en az bir nokta üretilir.
  const ham = Number(days)
  const adet = Number.isFinite(ham) ? Math.max(1, Math.trunc(ham)) : RESTORE_POINT_DAYS
  const anahtarlar = []
  const gorulen = new Set()
  for (let i = 0; i < adet; i += 1) {
    const anahtar = dateKeyFor(now - i * GUN_MS)
    if (gorulen.has(anahtar)) continue
    gorulen.add(anahtar)
    anahtarlar.push({ dateKey: anahtar, dayOffset: i })
  }
  return anahtarlar
}

/** Yedek paketini kurar; içerik açık metindir, şifreleme ayrı adımda yapılır. */
export function buildBackupPayload({
  sessions = [],
  apiKeys = {},
  settings = {},
  stats = null,
  createdAt = Date.now(),
  sourceDeviceId = null,
  schemaVersion = CLOUD_SCHEMA_VERSION,
} = {}) {
  return {
    format: 'heraai-backup',
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion,
    cryptoVersion: CRYPTO_VERSION,
    createdAt,
    sourceDeviceId,
    counts: {
      sessions: Array.isArray(sessions) ? sessions.length : 0,
      apiKeyPools: Object.keys(apiKeys || {}).length,
      settings: Object.keys(settings || {}).length,
    },
    data: {
      sessions,
      apiKeys,
      settings,
      stats,
    },
  }
}

/** Sıkıştırma destekleniyor mu? (`CompressionStream` tarayıcıda vardır.) */
export function compressionAvailable() {
  return typeof globalThis.CompressionStream === 'function'
}

/** Baytları gzip'ler; desteklenmiyorsa ham baytı döner. */
export async function compressBytes(bytes) {
  if (!compressionAvailable()) return { bytes, compressed: false }
  const akis = new globalThis.CompressionStream('gzip')
  const yazici = akis.writable.getWriter()
  yazici.write(bytes)
  yazici.close()
  const parcalar = []
  const okuyucu = akis.readable.getReader()
  for (;;) {
    const { done, value } = await okuyucu.read()
    if (done) break
    parcalar.push(value)
  }
  let toplam = 0
  for (const parca of parcalar) toplam += parca.length
  const sonuc = new Uint8Array(toplam)
  let konum = 0
  for (const parca of parcalar) {
    sonuc.set(parca, konum)
    konum += parca.length
  }
  return { bytes: sonuc, compressed: true }
}

/** gzip'lenmiş baytları açar. */
export async function decompressBytes(bytes) {
  const akis = new globalThis.DecompressionStream('gzip')
  const yazici = akis.writable.getWriter()
  yazici.write(bytes)
  yazici.close()
  const parcalar = []
  const okuyucu = akis.readable.getReader()
  for (;;) {
    const { done, value } = await okuyucu.read()
    if (done) break
    parcalar.push(value)
  }
  let toplam = 0
  for (const parca of parcalar) toplam += parca.length
  const sonuc = new Uint8Array(toplam)
  let konum = 0
  for (const parca of parcalar) {
    sonuc.set(parca, konum)
    konum += parca.length
  }
  return sonuc
}

function encoder() {
  return new TextEncoder()
}

function decoder() {
  return new TextDecoder()
}

/**
 * Şifreli tam veri yedeği üretir: `.heraai-backup` içeriği.
 * Zarf açık alanlar (biçim, sürüm, tarih, sayaçlar) + `backupKey` ile
 * şifrelenmiş veri taşır; sohbet içeriği düz metin olarak dosyada görünmez.
 */
export async function encryptBackup({
  backupKey,
  payload,
  compress = compressionAvailable(),
} = {}) {
  if (!backupKey) throw new Error('backup_key_missing')
  if (!payload || typeof payload !== 'object') throw new Error('backup_payload_missing')

  const ham = encoder().encode(JSON.stringify(payload))
  const { bytes, compressed } = compress ? await compressBytes(ham) : { bytes: ham, compressed: false }
  const zarf = await encryptJson(backupKey, { base64: bytesToBase64(bytes) })

  return {
    format: 'heraai-backup',
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: payload.schemaVersion ?? CLOUD_SCHEMA_VERSION,
    cryptoVersion: payload.cryptoVersion ?? CRYPTO_VERSION,
    createdAt: payload.createdAt ?? Date.now(),
    sourceDeviceId: payload.sourceDeviceId ?? null,
    counts: payload.counts ?? null,
    compressed,
    nonce: zarf.nonce,
    ciphertext: zarf.ciphertext,
  }
}

/** Şifreli yedeği çözer; bozuk/yanlış anahtar `backup_decrypt_failed` üretir. */
export async function decryptBackup({ backupKey, envelope } = {}) {
  if (!backupKey) throw new Error('backup_key_missing')
  if (!envelope?.ciphertext || !envelope?.nonce) throw new Error('backup_envelope_invalid')
  if (envelope.format && envelope.format !== 'heraai-backup') throw new Error('backup_format_invalid')
  if (Number(envelope.formatVersion) > BACKUP_FORMAT_VERSION) {
    throw new Error('backup_version_unsupported')
  }

  let yuk
  try {
    yuk = await decryptJson(backupKey, { nonce: envelope.nonce, ciphertext: envelope.ciphertext })
  } catch {
    throw new Error('backup_decrypt_failed')
  }

  const ham = base64ToBytesSafe(yuk?.base64)
  if (!ham) throw new Error('backup_decrypt_failed')

  let jsonBayt = ham
  if (envelope.compressed) {
    if (typeof globalThis.DecompressionStream !== 'function') {
      throw new Error('backup_decompress_unavailable')
    }
    try {
      jsonBayt = await decompressBytes(ham)
    } catch {
      throw new Error('backup_decompress_failed')
    }
  }

  try {
    const veri = JSON.parse(decoder().decode(jsonBayt))
    if (veri?.format !== 'heraai-backup') throw new Error('backup_format_invalid')
    return veri
  } catch (error) {
    if (error?.message === 'backup_format_invalid') throw error
    throw new Error('backup_parse_failed')
  }
}

function base64ToBytesSafe(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const ikili = globalThis.atob(value)
    const bayt = new Uint8Array(ikili.length)
    for (let i = 0; i < ikili.length; i += 1) bayt[i] = ikili.charCodeAt(i)
    return bayt
  } catch {
    return null
  }
}

/**
 * Geçmiş revizyonlardan istenen andaki durumu hesaplar.
 *
 * Her varlık için `targetTimeMs` anından **sonra olmayan** en yeni sürüm
 * seçilir. Hiçbir sürüm uygun değilse varlık atlanır (o anda yoktu).
 *
 * @param {object} options
 * @param {Array} options.entities Güncel varlıklar (`{ opaqueEntityId, entityType, entityVersion, document }`).
 * @param {Array} options.revisions Geçmiş sürümler (`{ opaqueEntityId, entityType, revisionId, entityVersion, document }`).
 * @param {number} options.targetTimeMs Hedef an.
 */
export function restoreStateAt({ entities = [], revisions = [], targetTimeMs } = {}) {
  const hedef = sayi(targetTimeMs)
  if (hedef === null) throw new Error('restore_target_missing')

  const gruplar = new Map()
  const ekle = (kayit, guncelMi) => {
    if (!kayit?.opaqueEntityId) return
    const surum = parseEntityVersion(kayit.entityVersion)
    if (!surum) return
    const liste = gruplar.get(kayit.opaqueEntityId) || []
    liste.push({ ...kayit, entityVersion: surum, isCurrent: Boolean(guncelMi) })
    gruplar.set(kayit.opaqueEntityId, liste)
  }

  for (const kayit of revisions) ekle(kayit, false)
  for (const kayit of entities) ekle(kayit, true)

  const secilenler = []
  for (const [opaqueEntityId, liste] of gruplar) {
    const uygun = liste.filter(kayit => kayit.entityVersion.wallTimeMs <= hedef)
    if (uygun.length === 0) continue
    uygun.sort((a, b) => compareEntityVersions(b.entityVersion, a.entityVersion))
    const en = uygun[0]
    const guncel = liste.find(kayit => kayit.isCurrent)
    secilenler.push({
      opaqueEntityId,
      entityType: en.entityType,
      entityVersion: en.entityVersion,
      document: en.document,
      deleted: en.document?.deleted === true,
      revisionId: en.revisionId || buildRevisionId(en.entityVersion),
      // Güncel sürüm hedef andan yeniyse geri alma gerçekten bir şey değiştirir.
      changed: !guncel || compareEntityVersions(guncel.entityVersion, en.entityVersion) !== 0,
    })
  }

  return secilenler.sort((a, b) => (a.opaqueEntityId < b.opaqueEntityId ? -1 : 1))
}

/** Saklama süresi dolmuş revizyonları süzer (varsayılan 7 gün). */
export function pruneExpiredRevisions(revisions, { now = Date.now(), days = RESTORE_POINT_DAYS } = {}) {
  const kalanlar = []
  const atilanlar = []
  for (const kayit of revisions || []) {
    const surum = parseEntityVersion(kayit?.entityVersion)
    if (!surum) {
      atilanlar.push(kayit)
      continue
    }
    if (isRevisionExpired(surum.wallTimeMs, now, days)) atilanlar.push(kayit)
    else kalanlar.push(kayit)
  }
  return { kept: kalanlar, dropped: atilanlar }
}

/**
 * Hesap Kurtarma Kiti metni (`heraai-recovery-kit.txt`).
 * API anahtarı ve sohbet içeriği taşımaz.
 */
export function recoveryKitDocument({
  code,
  email,
  keyVersion = CRYPTO_VERSION,
  schemaVersion = CLOUD_SCHEMA_VERSION,
  createdAt = null,
  locale = 'tr',
} = {}) {
  const tarih = createdAt ? new Date(createdAt).toISOString().slice(0, 10) : ''
  const kod = String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/(.{4})(?=.)/g, '$1-')
  const tr = locale !== 'en'
  const satirlar = tr
    ? [
        'HeraAi Hesap Kurtarma Kiti',
        '==========================',
        '',
        `Hesap: ${maskAccount(email)}`,
        tarih ? `Oluşturma: ${tarih}` : null,
        `Anahtar sürümü: v${keyVersion} · Şema: v${schemaVersion}`,
        '',
        'Kurtarma kodu:',
        kod,
        '',
        'NE İŞE YARAR',
        '- Yeni bir cihazdan şifreli eşitleme verilerinize erişmenizi sağlar.',
        '- Tek başına hesabınızı açmaz; Google girişi de gerekir.',
        '',
        'ACİL DURUM TALİMATLARI',
        '1. Bu dosyayı güvenli bir yerde saklayın (parola yöneticisi veya kasa).',
        '2. Cihazınızı kaybederseniz: HeraAi kurun, Google ile giriş yapın,',
        '   "Kurtarma koduyla bağlan" seçeneğine bu kodu girin.',
        '3. Kod kaybolursa bulut verileri kurtarılamaz: HeraAi sunucuları',
        '   anahtarınızı göremez, sıfırlama yapamaz.',
        '',
        'BU DOSYADA NE YOK',
        '- API anahtarları yoktur.',
        '- Sohbet içerikleri yoktur.',
        '- Google şifreniz yoktur.',
        '',
      ]
    : [
        'HeraAi Account Recovery Kit',
        '===========================',
        '',
        `Account: ${maskAccount(email)}`,
        tarih ? `Created: ${tarih}` : null,
        `Key version: v${keyVersion} · Schema: v${schemaVersion}`,
        '',
        'Recovery code:',
        kod,
        '',
        'WHAT IT DOES',
        '- Lets you access your encrypted sync data from a new device.',
        '- It does not unlock your account alone; Google sign-in is also required.',
        '',
        'EMERGENCY INSTRUCTIONS',
        '1. Keep this file somewhere safe (password manager or vault).',
        '2. If you lose your device: install HeraAi, sign in with Google,',
        '   choose "Connect with recovery code" and enter this code.',
        '3. If the code is lost, cloud data cannot be recovered: HeraAi servers',
        '   cannot see your key and cannot reset it.',
        '',
        'WHAT THIS FILE DOES NOT CONTAIN',
        '- No API keys.',
        '- No chat contents.',
        '- No Google password.',
        '',
      ]
  return satirlar.filter(s => s !== null).join('\n')
}

/** Yedek dosya adı: `heraai-yedek-2026-09-22.heraai-backup`. */
export function backupFileName({ now = Date.now(), prefix = 'heraai-yedek' } = {}) {
  return `${prefix}-${dateKeyFor(now)}${BACKUP_EXTENSION}`
}

/** Yedek zarfının özeti (arayüzde gösterilir). */
export function summarizeBackup(envelope) {
  if (!envelope) return null
  return {
    createdAt: envelope.createdAt || null,
    counts: envelope.counts || null,
    compressed: Boolean(envelope.compressed),
    formatVersion: Number(envelope.formatVersion) || BACKUP_FORMAT_VERSION,
    sizeBytes: typeof envelope.ciphertext === 'string' ? envelope.ciphertext.length : 0,
  }
}

/** Katmanın tanıtımı (test ve dokümantasyon). */
export function describeBackupLayer() {
  return {
    extension: BACKUP_EXTENSION,
    recoveryKit: RECOVERY_KIT_FILENAME,
    restorePointDays: RESTORE_POINT_DAYS,
    formatVersion: BACKUP_FORMAT_VERSION,
    compression: compressionAvailable() ? 'gzip' : 'none',
  }
}
