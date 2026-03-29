const LANGUAGE_PATTERNS = {
  turkish: /[çğıışöüÇĞIŞÖÜ]/,
  english: /[a-zA-Z]/,
  arabic: /[\u0600-\u06FF]/,
  russian: /[\u0400-\u04FF]/,
  chinese: /[\u4e00-\u9fff]/i,
  japanese: /[\u3040-\u309f\u30a0-\u30ff]/i,
  korean: /[\uac00-\ud7af]/i,
  spanish: /[ñáéíóúü]/i,
  german: /[äöüß]/i,
  french: /[àâçéèêëïîôùûüÿ]/i,
  portuguese: /[ãõç]/i,
}

export const detectLanguage = (text) => {
  if (!text || text.trim().length < 3) return null

  const turkishChars = (text.match(/[çğıışöüÇĞIŞÖÜ]/g) || []).length
  const englishChars = (text.match(/[a-zA-Z]/g) || []).length
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length
  const russianChars = (text.match(/[\u0400-\u04FF]/g) || []).length
  
  const totalChars = text.length
  const threshold = totalChars * 0.3

  if (turkishChars > threshold) return 'Turkish'
  if (arabicChars > threshold) return 'Arabic'
  if (russianChars > threshold) return 'Russian'
  if (englishChars > threshold * 2) return 'English'
  
  if (LANGUAGE_PATTERNS.chinese.test(text)) return 'Chinese'
  if (LANGUAGE_PATTERNS.japanese.test(text)) return 'Japanese'
  if (LANGUAGE_PATTERNS.korean.test(text)) return 'Korean'
  if (LANGUAGE_PATTERNS.spanish.test(text)) return 'Spanish'
  if (LANGUAGE_PATTERNS.german.test(text)) return 'German'
  if (LANGUAGE_PATTERNS.french.test(text)) return 'French'
  if (LANGUAGE_PATTERNS.portuguese.test(text)) return 'Portuguese'

  return 'English'
}

export const getLanguageFlag = (language) => {
  const flags = {
    Turkish: '🇹🇷',
    English: '🇬🇧',
    Arabic: '🇸🇦',
    Russian: '🇷🇺',
    Chinese: '🇨🇳',
    Japanese: '🇯🇵',
    Korean: '🇰🇷',
    Spanish: '🇪🇸',
    German: '🇩🇪',
    French: '🇫🇷',
    Portuguese: '🇵🇹',
  }
  return flags[language] || '🌐'
}
