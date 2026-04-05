const { logger } = require('../lib/logger')

function errorHandler(err, req, res, next) {
  logger.error(err.message, { stack: err.stack, path: req.path })
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
