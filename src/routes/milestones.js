const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')
const { sendPush } = require('../lib/push')

// GET /milestones/journey/:journeyId — list all milestones for a journey
router.get('/journey/:journeyId', requireAuth, async (req, res, next) => {
  try {
    // Verify membership
    const { data: member } = await adminSupabase
      .from('journey_members')
      .select('id')
      .eq('journey_id', req.params.journeyId)
      .eq('user_id', req.user.id)
      .single()

    if (!member) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } })
    }

    const { data: milestones, error } = await adminSupabase
      .from('milestones')
      .select('*, milestone_reflections(user_id, reflection_text, submitted_at)')
      .eq('journey_id', req.params.journeyId)
      .order('week_number', { ascending: true })

    if (error) throw error
    res.json({ success: true, milestones })
  } catch (err) { next(err) }
})

// POST /milestones/:id/reflect — submit a reflection for a milestone
router.post('/:id/reflect', requireAuth, async (req, res, next) => {
  try {
    const { reflection_text } = req.body
    if (!reflection_text || reflection_text.length < 10) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'reflection_text must be at least 10 characters' }
      })
    }

    const { data: milestone } = await adminSupabase
      .from('milestones')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (!milestone) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } })
    }
    if (!milestone.is_unlocked) {
      return res.status(400).json({
        success: false,
        error: { code: 'MILESTONE_LOCKED', message: 'This milestone has not been unlocked yet' }
      })
    }

    // Verify membership
    const { data: member } = await adminSupabase
      .from('journey_members')
      .select('id')
      .eq('journey_id', milestone.journey_id)
      .eq('user_id', req.user.id)
      .single()

    if (!member) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } })
    }

    // Check for duplicate
    const { data: existing } = await adminSupabase
      .from('milestone_reflections')
      .select('id')
      .eq('milestone_id', req.params.id)
      .eq('user_id', req.user.id)
      .single()

    if (existing) {
      return res.status(400).json({
        success: false,
        error: { code: 'ALREADY_REFLECTED', message: 'You have already submitted a reflection for this milestone' }
      })
    }

    const { data: reflection, error } = await adminSupabase
      .from('milestone_reflections')
      .insert({
        milestone_id: req.params.id,
        user_id: req.user.id,
        reflection_text
      })
      .select()
      .single()

    if (error) throw error

    // Post a system message to the journey chat
    const { data: user } = await adminSupabase
      .from('users').select('full_name').eq('id', req.user.id).single()

    await adminSupabase.from('messages').insert({
      journey_id: milestone.journey_id,
      sender_id: req.user.id,
      content: `${user.full_name} submitted their Week ${milestone.week_number} reflection.`,
      type: 'milestone_unlock'
    })

    res.status(201).json({ success: true, reflection })
  } catch (err) { next(err) }
})

module.exports = router
