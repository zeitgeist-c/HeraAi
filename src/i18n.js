import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';
import tr from './locales/tr.json';
import es from './locales/es.json';
import de from './locales/de.json';
import fr from './locales/fr.json';
import it from './locales/it.json';
import ptBR from './locales/pt-BR.json';
import ru from './locales/ru.json';
import zhCN from './locales/zh-CN.json';
import ja from './locales/ja.json';
import pl from './locales/pl.json';
import nl from './locales/nl.json';
import ko from './locales/ko.json';

/**
 * Every language the app ships. The order is the order the picker shows, and
 * each label is written in its own language - someone looking for their
 * language should not have to read English first.
 *
 * Adding one means: drop the JSON in src/locales, import it here, add the entry
 * below. scripts/i18n-gate.mjs then keeps it honest.
 */
export const LANGUAGES = [
    { code: 'en', label: 'English' },
    { code: 'tr', label: 'Türkçe' },
    { code: 'de', label: 'Deutsch' },
    { code: 'es', label: 'Español' },
    { code: 'fr', label: 'Français' },
    { code: 'it', label: 'Italiano' },
    { code: 'pt-BR', label: 'Português (Brasil)' },
    { code: 'ru', label: 'Русский' },
    { code: 'pl', label: 'Polski' },
    { code: 'nl', label: 'Nederlands' },
    { code: 'zh-CN', label: '简体中文' },
    { code: 'ja', label: '日本語' },
    { code: 'ko', label: '한국어' },
];

i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
        resources: {
            en: { translation: en },
            tr: { translation: tr },
            es: { translation: es },
            de: { translation: de },
            fr: { translation: fr },
            it: { translation: it },
            'pt-BR': { translation: ptBR },
            ru: { translation: ru },
            'zh-CN': { translation: zhCN },
            ja: { translation: ja },
            pl: { translation: pl },
            nl: { translation: nl },
            ko: { translation: ko },
        },
        fallbackLng: 'en',
        lng: 'en',
        supportedLngs: LANGUAGES.map((l) => l.code),
        // Keep the region when it carries meaning (pt-BR vs pt, zh-CN vs zh);
        // collapsing to the base code would miss the resource key entirely.
        load: 'currentOnly',
        interpolation: {
            escapeValue: false,
        },
        detection: {
            // Explicit user choice only. Navigator/OS must never override the
            // English default on fresh profiles (order excludes navigator).
            order: ['localStorage'],
            lookupLocalStorage: 'heraai.language',
            caches: ['localStorage'],
        },
    });

export default i18n;
