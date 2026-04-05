const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')

// POST /disputes — file a dispute
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { journey_id, type, description } = req.body
    const validTypes = ['partner_inactive', 'stake_not_returned', 'technical_error', 'other']

    if (!journey_id || !type || !description) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'journey_id, type and description are required' }
      })
    }
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_TYPE', message: `type must be one of: ${validTypes.join(', ')}` }
      })
    }
    if (description.length < 20) {
      return res.status(400).json({
        success: false,
        error: { code: 'DESCRIPTION_TOO_SHORT', message: 'description must be at least 20 characters' }
      })
    }

    const { data, error } = await adminSupabase
      .from('disputes')
      .insert({
        reporter_id: req.user.id,
        journey_id,
        type,
        description
      })
      .select()
      .single()

    if (error) throw error
    res.status(201).json({ success: true, dispute: data })
  } catch (err) { next(err) }
})

// GET /disputes — get current user's filed disputes
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await adminSupabase
      .from('disputes')
      .select('*')
      .eq('reporter_id', req.user.id)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json({ success: true, disputes: data })
  } catch (err) { next(err) }
})

module.exports = router
