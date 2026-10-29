/**
 * Dil kodu yardımcıları.
 *
 * Tarayıcı dili bölge ekli gelebilir (`tr-TR`); i18next çeviriyi `resolvedLanguage`
 * ile doğru yüklese de `i18n.language` bölge ekini taşır. Doğrudan `=== 'tr'`
 * karşılaştırması yapılırsa Türkçe arayüzde İngilizce metin/tarih çıkar.
 * Dil seçen tüm kod bu yardımcıyı kullanmalı.
 */

/** Desteklenen 13 arayuz dili. */
const SUPPORTED = new Set(['en', 'tr', 'de', 'es', 'fr', 'it', 'pt-BR', 'ru', 'pl', 'nl', 'zh-CN', 'ja', 'ko'])

/** Dil kodunu normalize eder: bolge eki kirpilir ('pt-BR' korunur); desteklenmeyen -> 'en'. */
export function baseLanguage(value) {
  const raw = String(value || '').replace('_', '-')
  if (SUPPORTED.has(raw)) return raw
  const lower = raw.toLowerCase()
  for (const code of SUPPORTED) {
    if (lower === code.toLowerCase() || lower.startsWith(code.toLowerCase() + '-')) return code
  }
  const short = lower.split('-')[0]
  for (const code of SUPPORTED) {
    if (code.toLowerCase().startsWith(short) || short.startsWith(code.toLowerCase())) return code
  }
  return 'en'
}

/** i18next'in yüklediği gerçek dil; bölge eki kırpılır. */
export function currentLanguage(i18n) {
  return baseLanguage(i18n?.resolvedLanguage || i18n?.language)
}
