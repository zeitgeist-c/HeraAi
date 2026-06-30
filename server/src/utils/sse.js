export function writeEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function endStream(res) {
  writeEvent(res, 'done', {});
  res.end();
}

export function sendError(res, code, message) {
  writeEvent(res, 'error', { code, message });
  res.end();
}
