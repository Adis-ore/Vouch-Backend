const logger = require('../config/logger')

// Fields that should never appear in logs
const SENSITIVE_FIELDS = new Set(['password', 'confirm_password', 'token', 'access_token', 'refresh_token', 'secret'])

function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_FIELDS.has(k) ? '[REDACTED]' : v
  }
  return out
}

function requestLogger(req, res, next) {
  const start = Date.now()
  const { method, originalUrl, body, query } = req

  // Log the incoming request
  const incoming = { method, url: originalUrl }
  if (Object.keys(query).length) incoming.query = query
  if (body && Object.keys(body).length) incoming.body = sanitize(body)

  logger.info(`→ ${method} ${originalUrl}`, incoming)

  // Capture response finish to log the outgoing response
  const originalJson = res.json.bind(res)
  res.json = function (data) {
    const ms = Date.now() - start
    const success = data?.success !== undefined ? data.success : res.statusCode < 400
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'

    logger[level](`← ${res.statusCode} ${method} ${originalUrl} (${ms}ms)`, {
      status: res.statusCode,
      ms,
      success,
      ...(success === false && data?.error ? { error: data.error } : {}),
    })

    return originalJson(data)
  }

  next()
}

module.exports = { requestLogger }
