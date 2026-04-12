const logger = require('../config/logger')
const { adminSupabase } = require('../lib/supabase')

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('[AUTH] Missing token', { path: req.originalUrl })
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing token' }
    })
  }

  const token = authHeader.split(' ')[1]
  const { data: { user }, error } = await adminSupabase.auth.getUser(token)

  if (error || !user) {
    logger.warn('[AUTH] Invalid token', { path: req.originalUrl, error: error?.message })
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid token' }
    })
  }

  logger.info('[AUTH] Authenticated', { userId: user.id, path: req.originalUrl })
  req.user = user
  next()
}

module.exports = { requireAuth }
