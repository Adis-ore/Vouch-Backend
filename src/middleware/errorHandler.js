const logger = require('../config/logger')

function errorHandler(err, req, res, next) {
  logger.error(`[ERROR] ${req.method} ${req.originalUrl} — ${err.message}`, {
    stack: err.stack,
    path: req.originalUrl,
    method: req.method,
    status: err.status || 500,
  })

  const status = err.status || 500
  res.status(status).json({
    success: false,
    error: {
      code: err.code || 'SERVER_ERROR',
      message: err.message || 'An unexpected error occurred'
    }
  })
}

module.exports = { errorHandler }
