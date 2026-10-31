/**
 * Language code helpers.
 *
 * The browser language may come with a region (`tr-TR`); even though i18next loads the
 * translation correctly via `resolvedLanguage`, `i18n.language` carries the region.
 * A direct `=== 'tr'` comparison yields English text/dates in the Turkish UI.
 * All code that selects a language must use this helper.
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

/** The real language i18next loaded; the region suffix is trimmed. */
export function currentLanguage(i18n) {
  return baseLanguage(i18n?.resolvedLanguage || i18n?.language)
}
