const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')

// POST /auth/register-profile — called after Supabase signup to create user profile
router.post('/register-profile', requireAuth, async (req, res, next) => {
  try {
    const { full_name, bio, avatar_url, country, region, phone } = req.body
    if (!full_name) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'full_name is required' }
      })
    }

    const { data, error } = await adminSupabase
      .from('users')
      .insert({
        id: req.user.id,
        full_name,
        bio,
        avatar_url,
        country: country || 'Nigeria',
        region: region || 'Lagos',
        phone
      })
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, user: data })
  } catch (err) { next(err) }
})

// POST /auth/push-token — save push notification token
router.post('/push-token', requireAuth, async (req, res, next) => {
  try {
    const { token } = req.body
    if (!token) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'token is required' }
      })
    }
    await adminSupabase
      .from('users')
      .update({ notification_token: token })
      .eq('id', req.user.id)
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
