const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')
const { updateStreak, checkAndAwardBadges } = require('../lib/streak')
const { sendPush } = require('../lib/push')

// POST /checkins — submit daily check-in
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { journey_id, note, proof_url, proof_type, next_step } = req.body
    const today = new Date().toISOString().split('T')[0]

    if (!journey_id || !note) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS' } })
    }
    if (note.length < 20) {
      return res.status(400).json({
        success: false,
        error: { code: 'NOTE_TOO_SHORT', message: 'Note must be at least 20 characters' }
      })
    }

    const { data: member } = await adminSupabase
      .from('journey_members')
      .select('*')
      .eq('journey_id', journey_id)
      .eq('user_id', req.user.id)
      .single()

    if (!member) {
      return res.status(403).json({ success: false, error: { code: 'NOT_MEMBER' } })
    }

    const { data: journey } = await adminSupabase
      .from('journeys').select('*').eq('id', journey_id).single()

    if (journey.status !== 'active') {
      return res.status(400).json({ success: false, error: { code: 'JOURNEY_NOT_ACTIVE' } })
    }

    const { data: existing } = await adminSupabase
      .from('checkins')
      .select('id')
      .eq('journey_id', journey_id)
      .eq('user_id', req.user.id)
      .eq('checkin_date', today)
      .single()

    if (existing) {
      return res.status(400).json({
        success: false,
        error: { code: 'ALREADY_CHECKED_IN', message: 'Already checked in today' }
      })
    }

    const { data: checkin, error } = await adminSupabase
      .from('checkins')
      .insert({
        journey_id,
        user_id: req.user.id,
        checkin_date: today,
        note,
        proof_url: proof_url || null,
        proof_type: proof_type || null,
        next_step: next_step || null
      })
      .select()
      .single()

    if (error) throw error

    const newStreak = await updateStreak(req.user.id, journey_id, today)
    await checkAndAwardBadges(req.user.id, newStreak)

    await adminSupabase
      .from('journey_members')
      .update({
        total_checkins: member.total_checkins + 1,
        last_checkin_date: today,
        consecutive_missed: 0
      })
      .eq('journey_id', journey_id)
      .eq('user_id', req.user.id)

    // Notify other members
    const { data: members } = await adminSupabase
      .from('journey_members')
      .select('user_id')
      .eq('journey_id', journey_id)
      .neq('user_id', req.user.id)

    const { data: checkinUser } = await adminSupabase
      .from('users').select('full_name').eq('id', req.user.id).single()

    for (const m of members) {
      await sendPush(
        m.user_id,
        'Check-in',
        `${checkinUser.full_name} just checked in on "${journey.title}"`,
        { journey_id }
      )
    }

    res.status(201).json({ success: true, checkin, current_streak: newStreak })
  } catch (err) { next(err) }
})

// POST /checkins/:id/verify — verify a teammate's check-in
router.post('/:id/verify', requireAuth, async (req, res, next) => {
  try {
    const { verdict } = req.body
    if (!['approve', 'flag'].includes(verdict)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_VERDICT' } })
    }

    const { data: checkin } = await adminSupabase
      .from('checkins')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (!checkin) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } })
    }
    if (checkin.user_id === req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'CANNOT_VERIFY_OWN' } })
    }

    const { data: existingVerification } = await adminSupabase
      .from('checkin_verifications')
      .select('id')
      .eq('checkin_id', req.params.id)
      .eq('verifier_id', req.user.id)
      .single()

    if (existingVerification) {
      return res.status(400).json({ success: false, error: { code: 'ALREADY_VERIFIED' } })
    }

    await adminSupabase.from('checkin_verifications').insert({
      checkin_id: req.params.id,
      verifier_id: req.user.id,
      verdict
    })

    if (verdict === 'approve') {
      await adminSupabase
        .from('checkins')
        .update({ verified_count: checkin.verified_count + 1 })
        .eq('id', req.params.id)

      const { data: verifiedUser } = await adminSupabase
        .from('users').select('reputation_score').eq('id', checkin.user_id).single()
      await adminSupabase
        .from('users')
        .update({ reputation_score: (verifiedUser.reputation_score || 0) + 1 })
        .eq('id', checkin.user_id)
    } else {
      const newFlagCount = checkin.flag_count + 1
      await adminSupabase
        .from('checkins')
        .update({ flag_count: newFlagCount })
        .eq('id', req.params.id)

      if (newFlagCount >= 3) {
        await adminSupabase
          .from('journey_members')
          .update({ current_streak: 0 })
          .eq('journey_id', checkin.journey_id)
          .eq('user_id', checkin.user_id)

        const { data: flaggedUser } = await adminSupabase
          .from('users').select('reputation_score').eq('id', checkin.user_id).single()
        await adminSupabase
          .from('users')
          .update({ reputation_score: Math.max(0, (flaggedUser.reputation_score || 0) - 5) })
          .eq('id', checkin.user_id)

        await sendPush(
          checkin.user_id,
          'Check-in flagged',
          'Your check-in was flagged by 3 members. Your streak has been reset.',
          { journey_id: checkin.journey_id }
        )
      }
    }

    res.json({ success: true })
  } catch (err) { next(err) }
})

// GET /checkins/journey/:journeyId — all check-ins for a journey
router.get('/journey/:journeyId', requireAuth, async (req, res, next) => {
  try {
    const { limit = 30, offset = 0 } = req.query
    const { data, error } = await adminSupabase
      .from('checkins')
      .select('*, user:users(id, full_name, avatar_url)')
      .eq('journey_id', req.params.journeyId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (error) throw error
    res.json({ success: true, checkins: data })
  } catch (err) { next(err) }
})

module.exports = router
