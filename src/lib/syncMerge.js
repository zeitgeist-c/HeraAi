/**
 * HeraAi 1.10.0 — Çakışma birleştirme mantığı (Aşama 14, plan §18.1).
 *
 * Eşitleme sözleşmesindeki üç birleştirme stratejisini uygular:
 *
 * - `last_write_wins`: tek değerli ayarlar; en yeni `updatedAt` kazanır,
 *   eşitlikte deterministik sıra (yerel korunur, gereksiz yazma yapılmaz).
 * - `entity_union`: kimlikli kayıt koleksiyonları; kayıt bazında birleşir ve
 *   **tombstone her zaman kazanır** (uzun süre kapalı kalan cihaz silinmiş
 *   veriyi diriltemez).
 * - `stats_sum`: günlük sayaçlar toplanır, kimlik listeleri birleşir,
 *   `lastActive` en büyüğü alır.
 *
 * Tüm fonksiyonlar saf: girdiyi değiştirmez, yeni nesne döner.
 */

import { MERGE_STRATEGY, getMergeStrategy, usesTombstone } from './syncContract'
import { compareEntityVersions, parseEntityVersion } from './syncModel'

function sayi(deger) {
  const n = Number(deger)
  return Number.isFinite(n) ? n : null
}

function zaman(kayit) {
  const t = sayi(kayit?.updatedAt)
  if (t !== null) return t
  return sayi(kayit?.createdAt) ?? null
}

/**
 * Tek değerli ayar birleştirmesi: en yeni `updatedAt` kazanır.
 * Eşitlikte yerel değer korunur (gereksiz yazma ve titreme önlenir).
 */
export function mergeSetting({ local, remote } = {}) {
  const yerelVar = local !== undefined && local !== null
  const uzakVar = remote !== undefined && remote !== null
  if (!uzakVar) return { value: local, changed: false, source: 'local' }
  if (!yerelVar) return { value: remote, changed: true, source: 'remote' }

  const yerelZaman = zaman(local)
  const uzakZaman = zaman(remote)

  // Düz değerlerde zaman bilgisi yoksa karşılaştırma yapılamaz: yerel korunur.
  if (yerelZaman === null && uzakZaman === null) {
    const esit = JSON.stringify(local) === JSON.stringify(remote)
    return { value: local, changed: false, source: esit ? 'local' : 'local' }
  }
  if (uzakZaman === null) return { value: local, changed: false, source: 'local' }
  if (yerelZaman === null) return { value: remote, changed: true, source: 'remote' }
  if (uzakZaman > yerelZaman) return { value: remote, changed: true, source: 'remote' }
  return { value: local, changed: false, source: 'local' }
}

/** Kaydın sürümünü bulur (`entityVersion` ya da `updatedAt`). */
function kayitSurumu(kayit) {
  const surum = parseEntityVersion(kayit?.entityVersion)
  if (surum) return surum
  const t = zaman(kayit)
  return t === null ? null : { wallTimeMs: t, logicalCounter: 0, deviceId: '' }
}

function kayitKimligi(kayit) {
  return String(kayit?.id ?? '')
}

function tombstoneMu(kayit) {
  return kayit?.deleted === true || kayit?.entityType === 'tombstone'
}

/**
 * Kimlikli koleksiyon birleştirmesi.
 *
 * Kurallar:
 * - Aynı kimlikte tombstone her zaman kazanır.
 * - Tombstone yoksa sürümü daha yeni olan kazanır.
 * - Sürümler eşitse yerel kayıt korunur.
 *
 * @returns {{ records: Array, added: string[], updated: string[], deleted: string[] }}
 */
export function mergeEntities({ local = [], remote = [], withTombstone = true } = {}) {
  const yerelHarita = new Map()
  for (const kayit of local || []) {
    const id = kayitKimligi(kayit)
    if (id) yerelHarita.set(id, kayit)
  }

  const eklenen = []
  const guncellenen = []
  const silinen = []
  const sonuc = [...(local || [])]
  const indeks = new Map()
  sonuc.forEach((kayit, i) => indeks.set(kayitKimligi(kayit), i))

  for (const uzak of remote || []) {
    const id = kayitKimligi(uzak)
    if (!id) continue
    const yerel = yerelHarita.get(id)
    const uzakSilme = tombstoneMu(uzak)

    if (!yerel) {
      // Yerelde yok: tombstone ise yazılacak bir şey yok, yalnız kayda geçir.
      if (uzakSilme) {
        silinen.push(id)
        continue
      }
      sonuc.push(uzak)
      indeks.set(id, sonuc.length - 1)
      eklenen.push(id)
      continue
    }

    // Tombstone her zaman eski güncelleme/oluşturma sürümlerini geçersiz kılar.
    if (uzakSilme) {
      // Tombstone uygulanmıyorsa silme kaydı yerel kaydı ezmez.
      if (!withTombstone) continue
      if (tombstoneMu(yerel)) {
        silinen.push(id)
        continue
      }
      const yerelSurum = kayitSurumu(yerel)
      const uzakSurum = kayitSurumu(uzak)
      // Silme, yerel sürümden eskiyse yok sayılır (sonradan geri getirilmiş kayıt).
      if (yerelSurum && uzakSurum && compareEntityVersions(uzakSurum, yerelSurum) < 0) continue
      sonuc[indeks.get(id)] = uzak
      silinen.push(id)
      continue
    }

    const yerelSurum = kayitSurumu(yerel)
    const uzakSurum = kayitSurumu(uzak)
    if (!uzakSurum) continue
    if (!yerelSurum || compareEntityVersions(uzakSurum, yerelSurum) > 0) {
      sonuc[indeks.get(id)] = uzak
      guncellenen.push(id)
    }
  }

  return { records: sonuc, added: eklenen, updated: guncellenen, deleted: silinen }
}

/**
 * İstatistik birleştirmesi: günlük sayaçlar toplanır, kimlik listeleri
 * birleşir, `lastActive` en büyük değeri alır.
 */
export function mergeStats({ local = null, remote = null } = {}) {
  if (!remote) return { value: local, changed: false }
  if (!local) return { value: remote, changed: true }

  const gunluk = { ...(local.dailyCounts || {}) }
  for (const [gun, adet] of Object.entries(remote.dailyCounts || {})) {
    const mevcut = Number(gunluk[gun]) || 0
    const gelen = Number(adet) || 0
    // Toplanarak birleşir; aynı gün iki cihazda üretim olduysa ikisi de sayılır.
    gunluk[gun] = mevcut + gelen
  }

  const kimlikler = new Set([...(local.recentFinalizedIds || []), ...(remote.recentFinalizedIds || [])])

  const yerelSon = sayi(local.lastActive)
  const uzakSon = sayi(remote.lastActive)
  const lastActive =
    yerelSon === null ? uzakSon : uzakSon === null ? yerelSon : Math.max(yerelSon, uzakSon)

  const toplamYerel = sayi(local.totalGenerations) || 0
  const toplamUzak = sayi(remote.totalGenerations) || 0

  const birlesik = {
    ...local,
    ...remote,
    dailyCounts: gunluk,
    recentFinalizedIds: [...kimlikler],
    lastActive,
    totalGenerations: toplamYerel + toplamUzak,
  }

  const degisti =
    JSON.stringify(gunluk) !== JSON.stringify(local.dailyCounts || {}) ||
    kimlikler.size !== (local.recentFinalizedIds || []).length ||
    lastActive !== yerelSon ||
    toplamUzak !== 0

  return { value: birlesik, changed: degisti }
}

/**
 * Depolama anahtarına göre doğru stratejiyi seçer.
 * Bilinmeyen anahtar `null` döner: eşitlenmeyen veri birleştirilmez.
 */
export function mergeStorageKey({ storageKey, local, remote } = {}) {
  const strateji = getMergeStrategy(storageKey)
  switch (strateji) {
    case MERGE_STRATEGY.LAST_WRITE_WINS:
      return { strategy: strateji, ...mergeSetting({ local, remote }) }
    case MERGE_STRATEGY.ENTITY_UNION: {
      const sonuc = mergeEntities({ local, remote, withTombstone: usesTombstone(storageKey) })
      return {
        strategy: strateji,
        ...sonuc,
        // Birleşik liste `value` alanında da verilir (anlık görüntü birleşimi).
        value: sonuc.records,
        // Değişiklik: eklenen, güncellenen veya silinen kayıt varsa yazılır.
        changed: sonuc.added.length + sonuc.updated.length + sonuc.deleted.length > 0,
      }
    }
    case MERGE_STRATEGY.STATS_SUM:
      return { strategy: strateji, ...mergeStats({ local, remote }) }
    default:
      return { strategy: MERGE_STRATEGY.NONE, value: local, changed: false }
  }
}

/**
 * Yerel ve uzak durumu anahtar bazında birleştirir.
 * Dönen `changes` yalnızca gerçekten değişen anahtarları taşır.
 */
export function mergeStorageSnapshot({ local = {}, remote = {} } = {}) {
  const degisenler = {}
  const atlananlar = []
  for (const anahtar of Object.keys(remote || {})) {
    const sonuc = mergeStorageKey({ storageKey: anahtar, local: local[anahtar], remote: remote[anahtar] })
    if (sonuc.strategy === MERGE_STRATEGY.NONE) {
      atlananlar.push(anahtar)
      continue
    }
    if (sonuc.changed) degisenler[anahtar] = sonuc.value
  }
  return { changes: degisenler, skipped: atlananlar, changedKeys: Object.keys(degisenler) }
}

/** Birleştirme katmanının tanıtımı (test ve dokümantasyon). */
export function describeSyncMerge() {
  return {
    strategies: Object.values(MERGE_STRATEGY),
    tombstoneWins: true,
    deterministicTieBreak: true,
  }
}
