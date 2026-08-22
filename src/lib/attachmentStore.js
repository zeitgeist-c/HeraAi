import { processAttachmentFile } from './fileParsers.js'

const DB_NAME = 'heraai-attachments'
const DB_VERSION = 1
const STORE_NAME = 'attachments'
const memoryStore = new Map()

function createAttachmentId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Attachment database could not be opened.'))
  })
}

async function writeOperation(operation) {
  const db = await openDatabase()
  if (!db) return operation(null)
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      try {
        operation(transaction.objectStore(STORE_NAME))
      } catch (error) {
        reject(error)
        return
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error || new Error('Attachment database transaction failed.'))
      transaction.onabort = () => reject(transaction.error || new Error('Attachment database transaction was aborted.'))
    })
  } finally {
    db.close()
  }
}

export async function putAttachment(prepared, preferredId = null) {
  const id = preferredId || createAttachmentId()
  const record = {
    id,
    blob: prepared.blob,
    ...(prepared.modelText ? { modelText: prepared.modelText } : {}),
    createdAt: Date.now(),
  }
  if (!globalThis.indexedDB) memoryStore.set(id, record)
  else await writeOperation(store => store.put(record))
  return {
    id,
    name: prepared.name,
    mimeType: prepared.mimeType,
    size: Number(prepared.size || prepared.blob?.size || 0),
    kind: prepared.kind,
    availability: 'ready',
  }
}

export async function getAttachment(id) {
  if (!id) return null
  if (!globalThis.indexedDB) return memoryStore.get(id) || null
  const db = await openDatabase()
  if (!db) return memoryStore.get(id) || null
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error || new Error('Attachment could not be read.'))
    })
  } finally {
    db.close()
  }
}

export async function deleteAttachment(id) {
  if (!id) return
  memoryStore.delete(id)
  if (globalThis.indexedDB) await writeOperation(store => store.delete(id))
}

export async function listAttachmentIds() {
  if (!globalThis.indexedDB) return Array.from(memoryStore.keys())
  const db = await openDatabase()
  if (!db) return Array.from(memoryStore.keys())
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAllKeys()
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error || new Error('Attachments could not be listed.'))
    })
  } finally {
    db.close()
  }
}

export function base64ToBlob(data, mimeType = 'application/octet-stream') {
  const encoded = String(data || '')
  if (encoded.length > Math.ceil((20 * 1024 * 1024 * 4) / 3) + 4) {
    const error = new Error('Legacy attachment exceeds 20 MB.')
    error.code = 'attachment_too_large'
    throw error
  }
  const binary = globalThis.atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mimeType })
}

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return globalThis.btoa(binary)
}

export function attachmentIdsFromSessions(sessions) {
  const ids = new Set()
  for (const session of sessions || []) {
    for (const id of session?.activeAttachmentIds || []) if (id) ids.add(id)
    for (const message of session?.messages || []) {
      for (const attachment of message?.attachments || []) if (attachment?.id) ids.add(attachment.id)
    }
  }
  return ids
}

export async function cleanupOrphanAttachments(sessions) {
  const usedIds = attachmentIdsFromSessions(sessions)
  const storedIds = await listAttachmentIds()
  await Promise.all(storedIds.filter(id => !usedIds.has(id)).map(deleteAttachment))
}

function attachmentKind(mimeType = '') {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'pdf'
  return 'text'
}

export async function migrateLegacySessionAttachments(sessions) {
  let changed = false
  const migrated = []
  for (const session of sessions || []) {
    const activeIds = new Set(session?.activeAttachmentIds || [])
    const messages = []
    for (const message of session?.messages || []) {
      const attachments = []
      for (const attachment of message?.attachments || []) {
        if (!attachment?.data || attachment?.id) {
          attachments.push(attachment)
          continue
        }
        try {
          const blob = base64ToBlob(attachment.data, attachment.mimeType)
          const name = attachment.name || 'attachment'
          const file = new File([blob], name, { type: attachment.mimeType || blob.type })
          const ref = await putAttachment(await processAttachmentFile(file))
          attachments.push(ref)
        } catch {
          attachments.push({
            name: attachment.name || 'attachment', mimeType: attachment.mimeType || 'application/octet-stream',
            size: 0, kind: attachmentKind(attachment.mimeType), availability: 'missing',
          })
        }
        changed = true
      }
      messages.push({ ...message, attachments })
    }
    if (activeIds.size === 0) {
      const lastUserWithAttachments = [...messages].reverse().find(message => (
        message?.role === 'user' && message?.attachments?.some(attachment => attachment?.id)
      ))
      for (const attachment of lastUserWithAttachments?.attachments || []) {
        if (attachment?.id) activeIds.add(attachment.id)
      }
    }
    migrated.push({ ...session, messages, activeAttachmentIds: Array.from(activeIds) })
  }
  return { sessions: migrated, changed }
}

export function stripAttachmentPayloads(sessions) {
  return (sessions || []).map(session => ({
    ...session,
    messages: (session?.messages || []).map(message => ({
      ...message,
      attachments: (message?.attachments || []).map(({ data: _data, modelText: _modelText, ...attachment }) => attachment),
    })),
  }))
}
