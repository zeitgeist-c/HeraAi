import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  Cloud,
  CloudOff,
  Copy,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Timer,
  Trash2,
  Download,
  Upload,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { AUTO_SYNC_OPTIONS_MINUTES, normalizeAutoSyncMinutes } from '../lib/autoSyncScheduler'
import { notifyError, notifySuccess } from '../lib/notify'
import { MAX_DEVICE_LABEL_LENGTH } from '../lib/syncModel'

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

// Katlanır başlık için kısa biçim: "23.09 23:42" (dar side panelde tam tarih taşıyor).
function formatCompactDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  const day = date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `${day} ${time}`
}

function SyncPanel() {
  const { t } = useTranslation()
  const [status, setStatus] = useState(null)
  const [devices, setDevices] = useState([])
  const [recoveryCode, setRecoveryCode] = useState('')
  const [recoveryInput, setRecoveryInput] = useState('')
  const [cleanupResult, setCleanupResult] = useState(null)
  const [busy, setBusy] = useState(null)
  const [renamingId, setRenamingId] = useState(null)
  const [labelDraft, setLabelDraft] = useState('')
  // Cihaz listesi kapalı başlar (kullanıcı kararı): panel kısa kalır, liste tıklayınca açılır.
  const [devicesExpanded, setDevicesExpanded] = useState(false)
  // Otomatik eşitleme: aralık + bugünkü kota kullanımı (cihaza özel ayar).
  const [autoSettings, setAutoSettings] = useState(null)
  const backupInputRef = useRef(null)
  const renameInputRef = useRef(null)

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
    try {
      const autoResponse = await sendMessage({ type: 'SYNC_GET_AUTO_SETTINGS' })
      if (autoResponse?.ok) setAutoSettings(autoResponse)
    } catch {
      // Ayar okunamazsa panel çalışmaya devam eder; varsayılan aralık geçerli olur.
    }
  }, [])

  useEffect(() => {
    refresh().catch(error => {
      setStatus({ signedIn: false, state: 'error', lastError: error.message })
    })
  }, [refresh])

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus()
  }, [renamingId])

  const perform = async (name, action, successMessage) => {
    setBusy(name)
    try {
      const response = await action()
      if (!response?.ok) throw new Error(response?.errorCode || 'sync_failed')
      if (successMessage) notifySuccess(successMessage)
      await refresh()
      return response
    } catch (error) {
      const translated = t(`setup.sync.errors.${error.message}`, { defaultValue: '' })
      notifyError(translated || t('setup.sync.error', { code: error.message }))
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

  const handleAutoInterval = minutes => perform(
    `auto:${minutes}`,
    () => sendMessage({ type: 'SYNC_SET_AUTO_INTERVAL', minutes }),
    t('setup.sync.auto_sync_saved'),
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

  const handleToggleDevice = device => perform(
    `device:${device.id}`,
    () => sendMessage({
      type: 'SYNC_SET_DEVICE_ENABLED',
      deviceId: device.id,
      enabled: Boolean(device.disabledAt),
    }),
    device.disabledAt ? t('setup.sync.device_enabled') : t('setup.sync.device_disabled'),
  )

  const startRenaming = device => {
    setRenamingId(device.id)
    setLabelDraft(device.label || '')
  }

  const cancelRenaming = () => {
    setRenamingId(null)
    setLabelDraft('')
  }

  const saveDeviceLabel = async device => {
    const next = labelDraft.trim()
    const current = (device.label || '').trim()
    setRenamingId(null)
    setLabelDraft('')
    if (!next || next === current) return
    await perform(
      `rename:${device.id}`,
      () => sendMessage({ type: 'SYNC_RENAME_DEVICE', deviceId: device.id, label: next }),
      t('setup.sync.renamed'),
    )
  }

  const handleRegenerateRecovery = async () => {
    if (!globalThis.confirm(t('setup.sync.regenerate_recovery_confirm'))) return
    const response = await perform(
      'recovery-regenerate',
      () => sendMessage({ type: 'SYNC_REGENERATE_RECOVERY' }),
      t('setup.sync.recovery_regenerated'),
    )
    if (response?.recoveryCode) setRecoveryCode(response.recoveryCode)
  }

  const handleLegacyCleanup = async () => {
    if (!globalThis.confirm(t('setup.sync.legacy_cleanup_confirm'))) return
    const response = await perform(
      'legacy-cleanup',
      () => sendMessage({ type: 'SYNC_CLEAN_LEGACY_CLOUD_DATA' }),
      t('setup.sync.legacy_cleanup_completed'),
    )
    if (response?.counts) setCleanupResult(response.counts)
  }

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

  if (status.cloudUnavailable) {
    const errorCode = status.lastErrorCode || status.lastError || 'sync_failed'
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <CloudOff className="h-4 w-4 text-amber-500" />
            {t('setup.sync.cloud_temporarily_unavailable_title')}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {t(`setup.sync.errors.${errorCode}`, { defaultValue: t('setup.sync.errors.sync_failed') })}
          </p>
          {Number(status.blockedUntil) > Date.now() && (
            <p className="mt-2 text-[10px] text-amber-500">
              {t('setup.sync.blocked_until', { date: formatDate(status.blockedUntil) })}
            </p>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            {t('setup.sync.google_session_preserved')}
          </p>
        </div>
        <button type="button" onClick={() => refresh()} disabled={busy !== null} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border px-4 text-xs font-semibold hover:bg-secondary disabled:opacity-50">
          <RefreshCw className="h-4 w-4" />
          {t('setup.sync.retry_status')}
        </button>
        <button type="button" onClick={handleSignOut} disabled={busy !== null} className="text-xs text-muted-foreground hover:text-foreground">{t('setup.sync.sign_out')}</button>
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

  const syncBlocked = Number(status.blockedUntil) > Date.now()
  const deviceDisabled = status.deviceDisabled === true
  // "Bu cihaz" her zaman en üstte; diğerleri mevcut sırasını korur (sort kararlı).
  const visibleDevices = devices
    .filter(device => !device.revokedAt)
    .sort((a, b) => Number(b.id === status.deviceId) - Number(a.id === status.deviceId))
  const disabledDeviceCount = visibleDevices.filter(device => device.disabledAt).length
  // Başlıkta hesabın en son eşitlenme zamanı: cihazların en yeni lastSyncedAt değeri.
  const latestDeviceSyncAt = visibleDevices.reduce((latest, device) => {
    const value = Number(device.lastSyncedAt) || 0
    return value > latest ? value : latest
  }, 0) || null

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
          <span className="flex items-center gap-2 text-xs font-semibold">{deviceDisabled || status.paused ? <CloudOff className="h-4 w-4 text-amber-500" /> : <Cloud className="h-4 w-4 text-green-500" />}{deviceDisabled ? t('setup.sync.device_disabled_status') : status.paused ? t('setup.sync.status_paused') : t('setup.sync.status_active')}</span>
          <span className="text-[10px] text-muted-foreground">{status.user?.email}</span>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
          <div><dt className="text-muted-foreground">{t('setup.sync.last_sync')}</dt><dd className="mt-0.5 font-medium">{formatDate(status.lastSyncAt)}</dd></div>
          <div><dt className="text-muted-foreground">{t('setup.sync.pending')}</dt><dd className="mt-0.5 font-medium">{status.pending || 0}</dd></div>
        </dl>
        {status.lastError && (
          <p className="mt-3 break-all text-[10px] text-destructive">
            {t(`setup.sync.errors.${status.lastErrorCode || status.lastError}`, {
              defaultValue: t('setup.sync.last_error', { code: status.lastError }),
            })}
          </p>
        )}
        {syncBlocked && (
          <p className="mt-2 text-[10px] text-amber-500">{t('setup.sync.blocked_until', { date: formatDate(status.blockedUntil) })}</p>
        )}
      </div>

      {deviceDisabled && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-3 text-[10px] leading-relaxed text-muted-foreground">
          <CloudOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <span>{t('setup.sync.device_disabled_notice')}</span>
        </div>
      )}

      <div className="rounded-xl border border-primary/20 bg-primary/[0.05] p-3 text-[10px] leading-relaxed text-muted-foreground">
        {t('setup.sync.attachments_local_notice')}
      </div>

      <div className="rounded-xl border border-border/70 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-xs font-semibold">
            <Timer className="h-4 w-4 text-primary" />
            {t('setup.sync.auto_sync_title')}
          </span>
          {autoSettings?.slowMode && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-500">
              {t('setup.sync.auto_sync_slow_badge')}
            </span>
          )}
        </div>
        <div role="group" aria-label={t('setup.sync.auto_sync_title')} className="mt-2 grid grid-cols-4 gap-1">
          {AUTO_SYNC_OPTIONS_MINUTES.map(minutes => {
            const active = normalizeAutoSyncMinutes(autoSettings?.intervalMinutes) === minutes
            return (
              <button
                key={minutes}
                type="button"
                onClick={() => handleAutoInterval(minutes)}
                disabled={busy !== null || status.paused || deviceDisabled}
                aria-pressed={active}
                className={`h-8 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-50 ${active ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground hover:bg-secondary'}`}
              >
                {minutes === 0 ? t('setup.sync.auto_sync_off') : t('setup.sync.auto_sync_hours', { hours: minutes / 60 })}
              </button>
            )
          })}
        </div>
        {autoSettings && (
          <p className="mt-2 text-[10px] text-muted-foreground">
            {t('setup.sync.auto_sync_usage', {
              reads: Math.round((autoSettings.ratio?.reads || 0) * 100),
              writes: Math.round((autoSettings.ratio?.writes || 0) * 100),
            })}
          </p>
        )}
        {autoSettings?.slowMode && (
          <p className="mt-1 text-[10px] text-amber-500">{t('setup.sync.auto_sync_slow')}</p>
        )}
        <p className="mt-1 text-[10px] text-muted-foreground">
          {normalizeAutoSyncMinutes(autoSettings?.intervalMinutes) === 0
            ? t('setup.sync.auto_sync_off_note')
            : t('setup.sync.auto_sync_note')}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={handleSync} disabled={busy !== null || status.paused || syncBlocked || deviceDisabled} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary text-xs font-semibold text-primary-foreground disabled:opacity-50">{busy === 'sync' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{t('setup.sync.sync_now')}</button>
        <button type="button" onClick={handlePause} disabled={busy !== null} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-semibold hover:bg-secondary disabled:opacity-50">{status.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}{status.paused ? t('setup.sync.resume') : t('setup.sync.pause')}</button>
      </div>

      <section className={`overflow-hidden rounded-xl border bg-background/35 transition-colors ${devicesExpanded ? 'border-primary/30 shadow-sm shadow-primary/10' : 'border-border/75'}`}>
        <button
          id="devices-heading"
          type="button"
          onClick={() => setDevicesExpanded(current => !current)}
          aria-expanded={devicesExpanded}
          aria-controls="devices-panel"
          className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-secondary/45"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Smartphone className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate text-xs font-semibold text-foreground">{t('setup.sync.devices')}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {latestDeviceSyncAt && (
              <span aria-hidden="true" className="whitespace-nowrap text-[10px] text-muted-foreground">
                {t('setup.sync.last_sync')} <span className="font-medium text-foreground">{formatCompactDateTime(latestDeviceSyncAt)}</span>
              </span>
            )}
            {disabledDeviceCount > 0 && (
              <span aria-hidden="true" className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-500">
                {t('setup.sync.device_off_count', { count: disabledDeviceCount })}
              </span>
            )}
            <span aria-hidden="true" className="inline-flex min-w-5 items-center justify-center rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {visibleDevices.length}
            </span>
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${devicesExpanded ? 'rotate-180' : ''}`} />
          </span>
        </button>
        {devicesExpanded && (
          <div id="devices-panel" role="region" aria-labelledby="devices-heading" className="border-t border-border/70 p-3">
            {visibleDevices.length === 0 && <p className="text-[10px] text-muted-foreground">—</p>}
            <div className="flex flex-col gap-2">
              {visibleDevices.map(device => {
            const isRenaming = renamingId === device.id
            const isDisabled = Boolean(device.disabledAt)
            return (
              <section key={device.id} className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 ${isDisabled ? 'border-amber-500/25 bg-amber-500/[0.04]' : 'border-border/75'}`}>
                <Smartphone className={`h-4 w-4 shrink-0 ${isDisabled ? 'text-amber-500' : 'text-primary'}`} />
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={labelDraft}
                    maxLength={MAX_DEVICE_LABEL_LENGTH}
                    aria-label={t('setup.sync.rename_placeholder')}
                    placeholder={t('setup.sync.rename_placeholder')}
                    onChange={event => setLabelDraft(event.target.value)}
                    onBlur={() => saveDeviceLabel(device)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        saveDeviceLabel(device)
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        cancelRenaming()
                      }
                    }}
                    className="h-7 min-w-0 flex-1 rounded-lg border border-primary/40 bg-background px-2 text-[11px] font-medium outline-none focus:ring-2 focus:ring-ring/40"
                  />
                ) : (
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-xs font-semibold text-foreground">{device.label || device.id}</span>
                      {device.id === status.deviceId && <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-semibold text-muted-foreground">{t('setup.sync.this_device')}</span>}
                      {isDisabled && <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-500">{t('setup.sync.device_off_badge')}</span>}
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {t('setup.sync.last_sync')} <span className="font-medium text-foreground">{device.lastSyncedAt ? formatDate(device.lastSyncedAt) : '—'}</span>
                    </p>
                  </div>
                )}
                <span className="flex shrink-0 items-center gap-1">
                  <button type="button" onClick={() => handleToggleDevice(device)} disabled={busy !== null} className={`hera-icon-button h-7 w-7 ${isDisabled ? 'text-amber-500' : ''}`} aria-pressed={!isDisabled} aria-label={isDisabled ? t('setup.sync.device_toggle_on') : t('setup.sync.device_toggle_off')} title={isDisabled ? t('setup.sync.device_toggle_on') : t('setup.sync.device_toggle_off')}>{isDisabled ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}</button>
                  <button type="button" onClick={() => startRenaming(device)} disabled={busy !== null} className="hera-icon-button h-7 w-7" aria-label={t('setup.sync.rename')} title={t('setup.sync.rename')}><Pencil className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => handleRevoke(device.id)} disabled={busy !== null} className="hera-icon-button h-7 w-7 text-destructive" aria-label={t('setup.sync.revoke')} title={t('setup.sync.revoke')}><Trash2 className="h-3.5 w-3.5" /></button>
                </span>
              </section>
            )
          })}
            </div>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border/70 p-3">
        <div className="flex items-start gap-2">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h3 className="text-xs font-semibold">{t('setup.sync.recovery_management_title')}</h3>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{t('setup.sync.recovery_management_description')}</p>
          </div>
        </div>
        <button type="button" onClick={handleRegenerateRecovery} disabled={busy !== null} className="mt-3 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-border text-[11px] font-semibold hover:bg-secondary disabled:opacity-50">
          {busy === 'recovery-regenerate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
          {t('setup.sync.regenerate_recovery')}
        </button>
      </section>

      <section className="rounded-xl border border-destructive/25 p-3">
        <h3 className="text-xs font-semibold">{t('setup.sync.legacy_cleanup_title')}</h3>
        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{t('setup.sync.legacy_cleanup_description')}</p>
        {cleanupResult && (
          <p className="mt-2 text-[10px] text-muted-foreground">
            {t('setup.sync.legacy_cleanup_summary', cleanupResult)}
          </p>
        )}
        {!cleanupResult && status.legacyCleanupCompletedAt && (
          <p className="mt-2 text-[10px] text-muted-foreground">
            {t('setup.sync.legacy_cleanup_last_completed', { date: formatDate(status.legacyCleanupCompletedAt) })}
          </p>
        )}
        <button type="button" onClick={handleLegacyCleanup} disabled={busy !== null} className="mt-3 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-destructive/30 text-[11px] font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-50">
          {busy === 'legacy-cleanup' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          {t('setup.sync.legacy_cleanup_action')}
        </button>
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
