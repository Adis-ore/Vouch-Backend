const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')

// GET /users/me — get current user profile with stats
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { data: user, error } = await adminSupabase
      .from('users')
      .select('*, badges(*)')
      .eq('id', req.user.id)
      .single()

    if (error || !user) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } })
    }

    res.json({ success: true, user })
  } catch (err) { next(err) }
})

// PATCH /users/me — update own profile
router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const allowed = ['full_name', 'bio', 'avatar_url', 'phone', 'region', 'streak_mode', 'notification_enabled']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'No valid fields to update' }
      })
    }

    const { data, error } = await adminSupabase
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, user: data })
  } catch (err) { next(err) }
})

// GET /users/:id — get a public user profile
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { data: user, error } = await adminSupabase
      .from('users')
      .select('id, full_name, avatar_url, bio, country, region, streak_total, longest_streak, journeys_completed, reputation_score, created_at, badges(*)')
      .eq('id', req.params.id)
      .single()

    if (error || !user) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } })
    }

    res.json({ success: true, user })
  } catch (err) { next(err) }
})

module.exports = router
