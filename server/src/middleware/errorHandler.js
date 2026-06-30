export function errorHandler(err, req, res, _next) {
  console.error('Unhandled error:', err);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Sunucu hatası.' },
  });
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Endpoint bulunamadı: ${req.method} ${req.path}` },
  });
}
