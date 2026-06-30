export function withTimeout(promise, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return promise.finally(() => clearTimeout(timer));
}
