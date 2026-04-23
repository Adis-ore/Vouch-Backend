async function requireAdmin(req, res, next) {
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'adisoreoluwa@gmail.com'

  // Static API key
  const apiKey = req.headers['x-admin-key']
  if (apiKey && apiKey === process.env.ADMIN_API_KEY) return next()

  // Bearer token issued by /admin/login
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1]
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf8')
      if (decoded === ADMIN_EMAIL + ':admin') return next()
    } catch (_) {}
  }

  return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required.' } })
}

module.exports = { requireAdmin }
