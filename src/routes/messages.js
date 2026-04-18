const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')

// GET /messages/journey/:journeyId — fetch messages for a journey
router.get('/journey/:journeyId', requireAuth, async (req, res, next) => {
  try {
    const { limit = 50, offset = 0 } = req.query

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

    const { data, error } = await adminSupabase
      .from('messages')
      .select('*, sender:users!sender_id(id, full_name, avatar_url)')
      .eq('journey_id', req.params.journeyId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (error) throw error
    res.json({ success: true, messages: data })
  } catch (err) { next(err) }
})

// POST /messages/journey/:journeyId — send a message
router.post('/journey/:journeyId', requireAuth, async (req, res, next) => {
  try {
    const { content } = req.body
    if (!content || !content.trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'content is required' }
      })
    }

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

    // Verify journey is active or open
    const { data: journey } = await adminSupabase
      .from('journeys')
      .select('status')
      .eq('id', req.params.journeyId)
      .single()

    if (!journey || !['open', 'active'].includes(journey.status)) {
      return res.status(400).json({
        success: false,
        error: { code: 'JOURNEY_NOT_ACTIVE', message: 'Cannot send messages in an inactive journey' }
      })
    }

    const { data: message, error } = await adminSupabase
      .from('messages')
      .insert({
        journey_id: req.params.journeyId,
        sender_id: req.user.id,
        content: content.trim(),
        type: 'text'
      })
      .select('*, sender:users!sender_id(id, full_name, avatar_url)')
      .single()

    if (error) throw error
    res.status(201).json({ success: true, message })
  } catch (err) { next(err) }
})

// PATCH /messages/:id — edit own message
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const { content } = req.body
    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS' } })
    }

    const { data: msg } = await adminSupabase
      .from('messages')
      .select('sender_id')
      .eq('id', req.params.id)
      .single()

    if (!msg) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } })
    if (msg.sender_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } })
    }

    const { data: updated, error } = await adminSupabase
      .from('messages')
      .update({ content: content.trim(), edited_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*, sender:users!sender_id(id, full_name, avatar_url)')
      .single()

    if (error) throw error
    res.json({ success: true, message: updated })
  } catch (err) { next(err) }
})

// DELETE /messages/:id — delete own message
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { data: msg } = await adminSupabase
      .from('messages')
      .select('sender_id')
      .eq('id', req.params.id)
      .single()

    if (!msg) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } })
    if (msg.sender_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } })
    }

    const { error } = await adminSupabase.from('messages').delete().eq('id', req.params.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
