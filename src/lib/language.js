/**
 * Dil kodu yardımcıları.
 *
 * Tarayıcı dili bölge ekli gelebilir (`tr-TR`); i18next çeviriyi `resolvedLanguage`
 * ile doğru yüklese de `i18n.language` bölge ekini taşır. Doğrudan `=== 'tr'`
 * karşılaştırması yapılırsa Türkçe arayüzde İngilizce metin/tarih çıkar.
 * Dil seçen tüm kod bu yardımcıyı kullanmalı.
 */

/** Dil kodunu temel dile indirger: 'tr', 'tr-TR', 'TR_tr' → 'tr'; diğerleri → 'en'. */
export function baseLanguage(value) {
  return String(value || '').toLowerCase().startsWith('tr') ? 'tr' : 'en'
}

/** i18next'in yüklediği gerçek dil; bölge eki kırpılır. */
export function currentLanguage(i18n) {
  return baseLanguage(i18n?.resolvedLanguage || i18n?.language)
}
