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
    this.keys = keyValues.map(k => ({
      key: k,
      masked: maskKey(k),
      provider,
      failCount: 0,
      lastErrorTime: null,
      cooldownUntil: null,
    }));
    this.cursor = 0;
  }

  isAvailable(key) {
    if (!key.cooldownUntil) return true;
    return Date.now() > key.cooldownUntil;
  }

  getNextKey() {
    const total = this.keys.length;
    if (total === 0) return null;

    for (let i = 0; i < total; i++) {
      const idx = (this.cursor + i) % total;
      if (this.isAvailable(this.keys[idx])) {
        this.cursor = (idx + 1) % total;
        return this.keys[idx];
      }
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

function parseKeys(multi, single) {
  if (multi && typeof multi === 'string') {
    const parts = multi.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts;
  }
  if (single && typeof single === 'string') {
    const trimmed = single.trim();
    if (trimmed) return [trimmed];
  }
  return [];
}

export { KeyPool, maskKey, parseKeys, ERROR_RETRYABLE, ERROR_NON_RETRYABLE };
