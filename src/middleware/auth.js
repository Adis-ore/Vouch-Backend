const { adminSupabase } = require('../lib/supabase')

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing token' }
    })
  }

  const token = authHeader.split(' ')[1]
  const { data: { user }, error } = await adminSupabase.auth.getUser(token)

  if (error || !user) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid token' }
    })
  }

  req.user = user
  next()
}

module.exports = { requireAuth }
