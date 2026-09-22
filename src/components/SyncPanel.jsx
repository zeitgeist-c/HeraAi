import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Cloud,
  CloudOff,
  Copy,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  Download,
  Upload,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { notifyError, notifySuccess } from '../lib/notify'

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, response => {
        const error = chrome.runtime?.lastError
        if (error) reject(new Error(error.message))
        else resolve(response)
      })
    } catch (error) {
      reject(error)
    }
  })
}

function formatDate(value) {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return '—'
  }
}

function SyncPanel() {
  const { t } = useTranslation()
  const [status, setStatus] = useState(null)
  const [devices, setDevices] = useState([])
  const [recoveryCode, setRecoveryCode] = useState('')
  const [recoveryInput, setRecoveryInput] = useState('')
  const [busy, setBusy] = useState(null)
  const backupInputRef = useRef(null)

  const refresh = useCallback(async () => {
    const response = await sendMessage({ type: 'SYNC_GET_STATUS' })
    if (!response?.ok) throw new Error(response?.errorCode || 'sync_failed')
    setStatus(response.status)
    if (response.status?.linked) {
      const deviceResponse = await sendMessage({ type: 'SYNC_LIST_DEVICES' })
      if (deviceResponse?.ok) setDevices(deviceResponse.devices || [])
    } else {
      setDevices([])
    }
  }, [])

  useEffect(() => {
    refresh().catch(error => {
      console.error('sync_status_failed', error)
      setStatus({ signedIn: false, state: 'error', lastError: error.message })
    })
  }, [refresh])

  const perform = async (name, action, successMessage) => {
    setBusy(name)
    try {
      const response = await action()
      if (!response?.ok) throw new Error(response?.errorCode || 'sync_failed')
      if (successMessage) notifySuccess(successMessage)
      await refresh()
      return response
    } catch (error) {
      notifyError(t('setup.sync.error', { code: error.message }))
      return null
    } finally {
      setBusy(null)
    }
  }

  const handleSignIn = () => perform(
    'signin',
    () => sendMessage({ type: 'AUTH_SIGN_IN' }),
    t('setup.sync.signed_in'),
  )

  const handleSignOut = () => perform(
    'signout',
    () => sendMessage({ type: 'AUTH_SIGN_OUT' }),
    t('setup.sync.signed_out'),
  )

  const handleInitialize = async () => {
    const response = await perform(
      'initialize',
      () => sendMessage({ type: 'SYNC_INITIALIZE' }),
      t('setup.sync.initialized'),
    )
    if (response?.recoveryCode) setRecoveryCode(response.recoveryCode)
  }

  const handleLink = () => perform(
    'link',
    () => sendMessage({ type: 'SYNC_LINK_DEVICE', recoveryCode: recoveryInput }),
    t('setup.sync.linked'),
  )

  const handleSync = () => perform(
    'sync',
    () => sendMessage({ type: 'SYNC_NOW' }),
    t('setup.sync.completed'),
  )

  const handlePause = () => perform(
    'pause',
    () => sendMessage({ type: 'SYNC_SET_PAUSED', paused: !status?.paused }),
    status?.paused ? t('setup.sync.resumed') : t('setup.sync.paused'),
  )

  const handleDisconnect = () => perform(
    'disconnect',
    () => sendMessage({ type: 'SYNC_DISCONNECT' }),
    t('setup.sync.disconnected'),
  )

  const handleRevoke = deviceId => perform(
    `revoke:${deviceId}`,
    () => sendMessage({ type: 'SYNC_REVOKE_DEVICE', deviceId }),
    t('setup.sync.device_revoked'),
  )

  const handleExportBackup = async () => {
    const response = await perform(
      'backup-export',
      () => sendMessage({ type: 'SYNC_EXPORT_BACKUP' }),
      t('setup.sync.backup_exported'),
    )
    if (!response?.backup) return
    const blob = new Blob([JSON.stringify(response.backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `HeraAi-${new Date().toISOString().slice(0, 10)}.heraai-backup`
    link.click()
    URL.revokeObjectURL(url)
  }

  const handleImportBackup = async event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const backup = JSON.parse(await file.text())
      await perform(
        'backup-import',
        () => sendMessage({ type: 'SYNC_IMPORT_BACKUP', backup }),
        t('setup.sync.backup_imported'),
      )
    } catch (error) {
      notifyError(t('setup.sync.error', { code: error.message }))
    }
  }

  if (!status) {
    return <div className="flex min-h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
  }

  if (!status.signedIn) {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-primary/20 bg-primary/[0.05] p-4">
          <div className="flex items-center gap-2 text-sm font-semibold"><Cloud className="h-4 w-4 text-primary" />{t('setup.sync.title')}</div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{t('setup.sync.description')}</p>
        </div>
        <button type="button" onClick={handleSignIn} disabled={busy !== null} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-50">
          {busy === 'signin' ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          {t('setup.sync.sign_in')}
        </button>
      </div>
    )
  }

  if (!status.accountExists) {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-primary/20 bg-primary/[0.05] p-4">
          <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-primary" />{t('setup.sync.first_device_title')}</div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{t('setup.sync.first_device_description')}</p>
        </div>
        <button type="button" onClick={handleInitialize} disabled={busy !== null} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-50">
          {busy === 'initialize' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          {t('setup.sync.create_account')}
        </button>
        <button type="button" onClick={handleSignOut} className="text-xs text-muted-foreground hover:text-foreground">{t('setup.sync.sign_out')}</button>
      </div>
    )
  }

  if (!status.linked) {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-4">
          <div className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="h-4 w-4 text-amber-500" />{t('setup.sync.recovery_required_title')}</div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{t('setup.sync.recovery_required_description')}</p>
        </div>
        <input value={recoveryInput} onChange={event => setRecoveryInput(event.target.value)} placeholder={t('setup.sync.recovery_placeholder')} className="h-10 rounded-xl border border-input bg-background px-3 font-mono text-xs" />
        <button type="button" onClick={handleLink} disabled={!recoveryInput.trim() || busy !== null} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-50">
          {busy === 'link' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Smartphone className="h-4 w-4" />}
          {t('setup.sync.link_device')}
        </button>
        <button type="button" onClick={handleSignOut} className="text-xs text-muted-foreground hover:text-foreground">{t('setup.sync.sign_out')}</button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {recoveryCode && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/[0.06] p-4">
          <p className="text-xs font-semibold text-red-600 dark:text-red-300">{t('setup.sync.save_recovery_title')}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{t('setup.sync.save_recovery_description')}</p>
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-500/20 bg-background/80 p-2">
            <code className="min-w-0 flex-1 break-all text-[11px]">{recoveryCode}</code>
            <button type="button" onClick={() => navigator.clipboard.writeText(recoveryCode).then(() => notifySuccess(t('setup.sync.copied')))} className="hera-icon-button"><Copy className="h-4 w-4" /></button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border/70 bg-secondary/30 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-xs font-semibold">{status.paused ? <CloudOff className="h-4 w-4 text-amber-500" /> : <Cloud className="h-4 w-4 text-green-500" />}{status.paused ? t('setup.sync.status_paused') : t('setup.sync.status_active')}</span>
          <span className="text-[10px] text-muted-foreground">{status.user?.email}</span>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
          <div><dt className="text-muted-foreground">{t('setup.sync.last_sync')}</dt><dd className="mt-0.5 font-medium">{formatDate(status.lastSyncAt)}</dd></div>
          <div><dt className="text-muted-foreground">{t('setup.sync.pending')}</dt><dd className="mt-0.5 font-medium">{status.pending || 0}</dd></div>
        </dl>
        {status.lastError && <p className="mt-3 break-all text-[10px] text-destructive">{t('setup.sync.last_error', { code: status.lastError })}</p>}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={handleSync} disabled={busy !== null || status.paused} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary text-xs font-semibold text-primary-foreground disabled:opacity-50">{busy === 'sync' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{t('setup.sync.sync_now')}</button>
        <button type="button" onClick={handlePause} disabled={busy !== null} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-semibold hover:bg-secondary disabled:opacity-50">{status.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}{status.paused ? t('setup.sync.resume') : t('setup.sync.pause')}</button>
      </div>

      <section>
        <h3 className="mb-2 text-xs font-semibold">{t('setup.sync.devices')}</h3>
        <div className="flex flex-col gap-2">
          {devices.map(device => (
            <div key={device.id} className="flex items-center gap-2 rounded-xl border border-border/70 p-2.5">
              <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1"><p className="truncate text-[11px] font-medium">{device.label || device.id}</p><p className="text-[10px] text-muted-foreground">{device.id === status.deviceId ? t('setup.sync.this_device') : formatDate(device.lastSyncedAt)}{device.revokedAt ? ` · ${t('setup.sync.revoked')}` : ''}</p></div>
              {!device.revokedAt && <button type="button" onClick={() => handleRevoke(device.id)} disabled={busy !== null} className="hera-icon-button text-destructive" aria-label={t('setup.sync.revoke')}><Trash2 className="h-3.5 w-3.5" /></button>}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold">{t('setup.sync.backup_title')}</h3>
        <p className="mb-2 text-[10px] leading-relaxed text-muted-foreground">{t('setup.sync.backup_description')}</p>
        <input ref={backupInputRef} type="file" accept=".heraai-backup,application/json" onChange={handleImportBackup} className="hidden" />
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={handleExportBackup} disabled={busy !== null} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border text-[11px] font-semibold hover:bg-secondary disabled:opacity-50"><Download className="h-3.5 w-3.5" />{t('setup.sync.export_backup')}</button>
          <button type="button" onClick={() => backupInputRef.current?.click()} disabled={busy !== null} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border text-[11px] font-semibold hover:bg-secondary disabled:opacity-50"><Upload className="h-3.5 w-3.5" />{t('setup.sync.import_backup')}</button>
        </div>
      </section>

      <div className="flex items-center justify-between border-t border-border/60 pt-3">
        <button type="button" onClick={handleDisconnect} disabled={busy !== null} className="text-[11px] text-destructive hover:underline">{t('setup.sync.disconnect')}</button>
        <button type="button" onClick={handleSignOut} disabled={busy !== null} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"><LogOut className="h-3.5 w-3.5" />{t('setup.sync.sign_out')}</button>
      </div>
    </div>
  )
}

export default SyncPanel
