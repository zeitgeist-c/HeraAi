import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { LANGUAGES } from '../i18n'

/**
 * Language picker for the settings panel.
 *
 * Two flat buttons worked while the app shipped two languages. With thirteen a
 * grid would either wrap into an unreadable block or push the rest of the panel
 * off screen, so this is a native select: keyboard accessible for free, and it
 * scales to any number of entries.
 *
 * Each option is written in its own language - someone looking for their own
 * language should not have to read the current one first.
 */
export default function LanguagePicker({ value, onChange }) {
    const { t } = useTranslation()

    const current = useMemo(
        () => LANGUAGES.find((l) => l.code === value) ?? LANGUAGES[0],
        [value],
    )

    return (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-border/70 bg-secondary/35 p-3">
            <div className="min-w-0">
                <span className="block text-xs font-semibold text-foreground">
                    {t('setup.general.language_title')}
                </span>
                <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                    {t('setup.general.language_description')}
                </span>
            </div>
            <div className="relative shrink-0">
                <select
                    aria-label={t('setup.general.language_title')}
                    value={current.code}
                    onChange={(event) => onChange(event.target.value)}
                    className="h-9 w-[13.5rem] cursor-pointer appearance-none rounded-lg border border-border/80 bg-background px-3 pr-8 text-[11px] font-medium text-foreground transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                    {LANGUAGES.map((lang) => (
                        <option key={lang.code} value={lang.code} lang={lang.code}>
                            {lang.label}
                        </option>
                    ))}
                </select>
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground"
                >
                    ▼
                </span>
            </div>
        </div>
    )
}
