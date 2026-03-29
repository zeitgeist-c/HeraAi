const ENCRYPTION_KEY_NAME = 'heraai_encryption_key'

async function getOrCreateEncryptionKey() {
  const storedKey = await chrome.storage.local.get([ENCRYPTION_KEY_NAME])
  
  if (storedKey[ENCRYPTION_KEY_NAME]) {
    return await crypto.subtle.importKey(
      'jwk',
      storedKey[ENCRYPTION_KEY_NAME],
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
  }
  
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )
  
  const exportedKey = await crypto.subtle.exportKey('jwk', key)
  await chrome.storage.local.set({ [ENCRYPTION_KEY_NAME]: exportedKey })
  
  return key
}

export async function encryptApiKeys(apiKeys) {
  if (!apiKeys || apiKeys.length === 0) return apiKeys
  
  try {
    const key = await getOrCreateEncryptionKey()
    const encoder = new TextEncoder()
    
    const encryptedKeys = await Promise.all(
      apiKeys.map(async (apiKey) => {
        const encodedKey = encoder.encode(apiKey)
        const iv = crypto.getRandomValues(new Uint8Array(12))
        
        const encryptedBuffer = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          key,
          encodedKey
        )
        
        const encryptedArray = Array.from(new Uint8Array(encryptedBuffer))
        const ivArray = Array.from(iv)
        
        return JSON.stringify({ iv: ivArray, data: encryptedArray })
      })
    )
    
    return encryptedKeys
  } catch (error) {
    console.error('Encryption error:', error)
    return apiKeys
  }
}

export async function decryptApiKeys(encryptedKeys) {
  if (!encryptedKeys || encryptedKeys.length === 0) return encryptedKeys
  
  try {
    const key = await getOrCreateEncryptionKey()
    const decoder = new TextDecoder()
    
    const decryptedKeys = await Promise.all(
      encryptedKeys.map(async (encryptedKey) => {
        if (encryptedKey.startsWith('AIza')) {
          return encryptedKey
        }
        
        const { iv: ivArray, data: dataArray } = JSON.parse(encryptedKey)
        const iv = new Uint8Array(ivArray)
        const data = new Uint8Array(dataArray)
        
        const decryptedBuffer = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv },
          key,
          data
        )
        
        return decoder.decode(decryptedBuffer)
      })
    )
    
    return decryptedKeys
  } catch (error) {
    console.error('Decryption error:', error)
    return encryptedKeys
  }
}

export async function encryptSingleKey(apiKey) {
  if (!apiKey || apiKey.startsWith('{')) return apiKey
  
  try {
    const key = await getOrCreateEncryptionKey()
    const encoder = new TextEncoder()
    
    const encodedKey = encoder.encode(apiKey)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    
    const encryptedBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encodedKey
    )
    
    const encryptedArray = Array.from(new Uint8Array(encryptedBuffer))
    const ivArray = Array.from(iv)
    
    return JSON.stringify({ iv: ivArray, data: encryptedArray })
  } catch (error) {
    console.error('Encryption error:', error)
    return apiKey
  }
}
