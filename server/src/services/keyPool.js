function maskKey(key) {
  if (!key || key.length <= 8) return '***';
  return key.slice(0, 4) + '...' + key.slice(-3);
}

const ERROR_RETRYABLE = {
  rateLimit: 'rateLimit',
  quotaExceeded: 'quotaExceeded',
  timeout: 'timeout',
  serverError: 'serverError',
};

const ERROR_NON_RETRYABLE = {
  badRequest: 'badRequest',
  authError: 'authError',
  safetyBlock: 'safetyBlock',
};

class KeyPool {
  constructor(provider, keyValues, cooldowns) {
    this.provider = provider;
    this.cooldowns = cooldowns;
    this.keys = (keyValues || []).map(k => ({
      id: k.id,
      key: k.key,
      isPrimary: k.isPrimary || false,
      masked: maskKey(k.key),
      provider,
      failCount: 0,
      lastErrorTime: null,
      cooldownUntil: null,
    }));
  }

  isAvailable(key) {
    if (!key.cooldownUntil) return true;
    return Date.now() > key.cooldownUntil;
  }

  getNextKey() {
    for (const entry of this.keys) {
      if (this.isAvailable(entry)) return entry;
    }
    return null;
  }

  markFailed(key, errorType) {
    key.failCount++;
    key.lastErrorTime = Date.now();

    const duration = this.cooldowns[errorType];
    if (duration) {
      key.cooldownUntil = Date.now() + duration;
    }
  }

  markSucceeded(key) {
    key.failCount = 0;
    key.lastErrorTime = null;
    key.cooldownUntil = null;
  }

  getStatus() {
    return {
      total: this.keys.length,
      available: this.keys.filter(k => this.isAvailable(k)).length,
      keys: this.keys.map(k => ({
        masked: k.masked,
        failCount: k.failCount,
        available: this.isAvailable(k),
      })),
    };
  }
}

function createPool(provider, keysArray, cooldowns) {
  if (!keysArray || !Array.isArray(keysArray)) {
    return new KeyPool(provider, [], cooldowns);
  }
  const keyValues = keysArray.map(k => ({ id: k.id, key: k.key, isPrimary: k.isPrimary }));
  return new KeyPool(provider, keyValues, cooldowns);
}

export { KeyPool, maskKey, createPool, ERROR_RETRYABLE, ERROR_NON_RETRYABLE };
