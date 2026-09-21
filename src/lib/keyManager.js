const PROVIDERS = ['gemini', 'tavily', 'openrouter', 'ollama'];
const STORAGE_KEYS = {
  gemini: 'geminiApiKeys',
  tavily: 'tavilyApiKeys',
  openrouter: 'openRouterApiKeys',
  ollama: 'ollamaApiKeys',
};

function getStorageKey(provider) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Invalid provider: ${provider}`);
  return STORAGE_KEYS[provider];
}

function maskKey(key) {
  if (!key || key.length <= 8) return '***';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function readStorage(key) {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get([key], (result) => resolve(result[key] || []));
    } else {
      const stored = localStorage.getItem(key);
      resolve(stored ? JSON.parse(stored) : []);
    }
  });
}

function writeStorage(key, data) {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ [key]: data, syncVaultUpdatedAt: Date.now() }, resolve);
    } else {
      localStorage.setItem(key, JSON.stringify(data));
      resolve();
    }
  });
}

export async function getKeys(provider) {
  const storageKey = getStorageKey(provider);
  const entries = await readStorage(storageKey);
  return entries
    .map((entry) => {
      const { key: _, ...rest } = entry;
      return rest;
    })
    .sort((a, b) => {
      if (a.isPrimary && !b.isPrimary) return -1;
      if (!a.isPrimary && b.isPrimary) return 1;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
}

export async function getRawKey(provider, id) {
  const entries = await readStorage(getStorageKey(provider));
  const entry = entries.find(e => e.id === id);
  return entry ? entry.key : null;
}

export async function addKey(provider, rawKey) {
  const storageKey = getStorageKey(provider);
  const entries = await readStorage(storageKey);

  const trimmed = rawKey.trim();
  if (!trimmed) throw new Error('key_empty_error');
  if (entries.some(e => e.key === trimmed)) throw new Error('key_duplicate_error');

  const isPrimary = entries.length === 0;
  const entry = {
    id: generateId(),
    key: trimmed,
    masked: maskKey(trimmed),
    isPrimary,
    createdAt: Date.now(),
    lastUsedAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorType: null,
    cooldownUntil: null,
    failCount: 0,
    updatedAt: Date.now(),
  };

  entries.push(entry);
  await writeStorage(storageKey, entries);
  return entry.id;
}

export async function removeKey(provider, id) {
  const storageKey = getStorageKey(provider);
  let entries = await readStorage(storageKey);
  const removedIndex = entries.findIndex(e => e.id === id);
  if (removedIndex === -1) return;

  const wasPrimary = entries[removedIndex].isPrimary;
  entries.splice(removedIndex, 1);

  if (wasPrimary && entries.length > 0) {
    entries[0].isPrimary = true;
  }

  await writeStorage(storageKey, entries);
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const tombstoneKey = `${storageKey}:${id}`;
    await new Promise((resolve) => {
      chrome.storage.local.get(['syncKeyTombstones'], (stored) => {
        chrome.storage.local.set({
          syncKeyTombstones: {
            ...(stored?.syncKeyTombstones || {}),
            [tombstoneKey]: Date.now(),
          },
        }, resolve);
      });
    });
  }
}

export async function setPrimary(provider, id) {
  const storageKey = getStorageKey(provider);
  const entries = await readStorage(storageKey);
  let found = false;

  for (const entry of entries) {
    if (entry.id === id) {
      entry.isPrimary = true;
      entry.updatedAt = Date.now();
      found = true;
    } else {
      entry.isPrimary = false;
      entry.updatedAt = Date.now();
    }
  }

  if (found) {
    await writeStorage(storageKey, entries);
  }
}

export async function updateKeyMetadata(provider, id, updates) {
  const storageKey = getStorageKey(provider);
  const entries = await readStorage(storageKey);
  const entry = entries.find(e => e.id === id);
  if (!entry) return;

  const allowed = ['lastUsedAt', 'lastSuccessAt', 'lastErrorAt', 'lastErrorType', 'cooldownUntil', 'failCount'];
  for (const field of allowed) {
    if (updates[field] !== undefined) {
      entry[field] = updates[field];
    }
  }
  entry.updatedAt = Date.now();

  await writeStorage(storageKey, entries);
}

export async function getAllKeysForRequest(provider) {
  const entries = await readStorage(getStorageKey(provider));
  const now = Date.now();

  const sorted = [...entries].sort((a, b) => {
    if (a.isPrimary) return -1;
    if (b.isPrimary) return 1;
    const aCooldown = a.cooldownUntil && a.cooldownUntil > now ? 1 : 0;
    const bCooldown = b.cooldownUntil && b.cooldownUntil > now ? 1 : 0;
    return aCooldown - bCooldown;
  });

  return sorted.map(e => ({ id: e.id, key: e.key, isPrimary: e.isPrimary }));
}

export async function resolveKeysForRequest(provider) {
  const entries = await readStorage(getStorageKey(provider));
  const now = Date.now();

  const available = [];
  const inCooldown = [];

  for (const entry of entries) {
    if (entry.cooldownUntil && entry.cooldownUntil > now) {
      inCooldown.push(entry);
    } else {
      available.push(entry);
    }
  }

  if (available.length === 0) {
    return {
      keys: [],
      allInCooldown: entries.length > 0,
      earliestCooldownEnd: inCooldown.length > 0
        ? Math.min(...inCooldown.map(e => e.cooldownUntil))
        : null,
    };
  }

  available.sort((a, b) => {
    if (a.isPrimary && !b.isPrimary) return -1;
    if (!a.isPrimary && b.isPrimary) return 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });

  return {
    keys: available.map(e => ({ id: e.id, key: e.key, isPrimary: e.isPrimary })),
    allInCooldown: false,
    earliestCooldownEnd: null,
  };
}
