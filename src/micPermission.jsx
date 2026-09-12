import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Mic, ShieldCheck } from 'lucide-react'
import { I18nextProvider, useTranslation } from 'react-i18next'

import i18n from './i18n'
import './index.css'

export function MicPermissionPage() {
  const { t } = useTranslation()
  const [status, setStatus] = useState('idle')
  const requestId = new URLSearchParams(window.location.search).get('requestId')

  useEffect(() => {
    let disposed = false
    Promise.resolve(chrome.storage?.local?.get?.(['language']))
      .then(result => {
        if (!disposed && ['en', 'tr'].includes(result?.language)) return i18n.changeLanguage(result.language)
        return undefined
      })
      .catch(() => undefined)
    return () => { disposed = true }
  }, [])

  const notify = (granted, errorCode) => chrome.runtime.sendMessage({
    type: 'HERAAI_MIC_PERMISSION_RESULT',
    requestId,
    granted,
    ...(errorCode ? { errorCode } : {}),
  }).catch(() => undefined)

  const requestPermission = async () => {
    setStatus('requesting')
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      stream.getTracks().forEach(track => track.stop())
      setStatus('granted')
      await notify(true)
      window.setTimeout(() => window.close(), 350)
    } catch (error) {
      const errorCode = error?.name === 'NotAllowedError' ? 'permission_denied' : 'microphone_unavailable'
      setStatus(errorCode)
      await notify(false, errorCode)
    }
  }

  return (
    <main className="hera-panel flex min-h-screen items-center justify-center bg-background p-5 text-foreground">
      <section className="hera-surface w-full max-w-sm rounded-2xl p-5 text-center shadow-xl">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          {status === 'granted' ? <ShieldCheck className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
        </span>
        <h1 className="mt-4 text-base font-semibold">{t('mic_permission.title')}</h1>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {status === 'permission_denied'
            ? t('mic_permission.denied')
            : status === 'microphone_unavailable'
              ? t('mic_permission.unavailable')
              : status === 'granted'
                ? t('mic_permission.granted')
                : t('mic_permission.description')}
        </p>
        {status !== 'granted' && (
          <button
            type="button"
            onClick={requestPermission}
            disabled={status === 'requesting'}
            className="mt-5 inline-flex h-10 w-full items-center justify-center rounded-xl bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-50"
          >
            {status === 'requesting' ? t('mic_permission.requesting') : t('mic_permission.allow')}
          </button>
        )}
      </section>
    </main>
  )
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <I18nextProvider i18n={i18n}>
      <MicPermissionPage />
    </I18nextProvider>
  )
}
