const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')
const { updateStreak } = require('../lib/streak')
const { checkAndAwardBadges } = require('../lib/badges')
const { updateReputation } = require('../lib/reputation')
const { completeJourneyForUser } = require('../lib/completion')
const { sendPush } = require('../lib/push')
const { getTimezoneForCountry, getLocalDate } = require('../lib/timezones')

// POST /checkins — submit daily check-in
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { journey_id, note, proof_url, proof_type, next_step } = req.body

    // Use user's local date (timezone-aware) so an 11 PM check-in counts for today not tomorrow
    const { data: userInfo } = await adminSupabase
      .from('users').select('country, timezone').eq('id', req.user.id).single()
    const timezone = userInfo?.timezone || getTimezoneForCountry(userInfo?.country)
    const today = getLocalDate(timezone)

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

    const newStreak = await updateStreak(req.user.id, journey_id, today, timezone)

    // Award streak + checkin badges
    await checkAndAwardBadges(req.user.id, { event: 'streak_updated', streak: newStreak })
    await checkAndAwardBadges(req.user.id, { event: 'checkin_submitted' })

    const newTotalCheckins = member.total_checkins + 1
    await adminSupabase
      .from('journey_members')
      .update({
        total_checkins: newTotalCheckins,
        last_checkin_date: today,
        consecutive_missed: 0
      })
      .eq('journey_id', journey_id)
      .eq('user_id', req.user.id)

    // Check if this check-in completes the journey for this user
    let journeyCompleted = false
    if (newTotalCheckins >= journey.duration_days) {
      const result = await completeJourneyForUser(journey_id, req.user.id)
      journeyCompleted = result.completed === true
    }

    // Notify other members
    const { data: members } = await adminSupabase
      .from('journey_members')
      .select('user_id')
      .eq('journey_id', journey_id)
      .eq('status', 'active')
      .neq('user_id', req.user.id)

    const { data: checkinUser } = await adminSupabase
      .from('users').select('full_name').eq('id', req.user.id).single()

    const notifRows = (members || []).map(m => ({
      user_id: m.user_id,
      type: 'partner_checkin',
      title: `${checkinUser?.full_name || 'Your partner'} checked in`,
      body: `"${journey.title}" — keep going!`,
      data: { route: 'journey', journey_id, tab: 'checkins' },
      read: false,
    }))
    if (notifRows.length) {
      adminSupabase.from('notifications').insert(notifRows).then(() => {}).catch(() => {})
      for (const m of members) {
        await sendPush(m.user_id, 'Check-in', `${checkinUser?.full_name || 'Your partner'} just checked in on "${journey.title}"`, { journey_id })
      }
    }

    res.status(201).json({ success: true, checkin, current_streak: newStreak, journey_completed: journeyCompleted })
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

    // New joiners cannot verify on the same day they joined
    const { data: verifierMember } = await adminSupabase
      .from('journey_members')
      .select('joined_at')
      .eq('journey_id', checkin.journey_id)
      .eq('user_id', req.user.id)
      .single()

    if (!verifierMember) {
      return res.status(403).json({ success: false, error: { code: 'NOT_MEMBER' } })
    }

    const joinedDate = verifierMember.joined_at?.split('T')[0]
    if (joinedDate === new Date().toISOString().split('T')[0]) {
      return res.status(403).json({ success: false, error: { code: 'NEW_JOINER', message: 'You cannot verify check-ins on the day you joined.' } })
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
    } else {
      const newFlagCount = checkin.flag_count + 1
      const { count: memberCount } = await adminSupabase
        .from('journey_members')
        .select('*', { count: 'exact', head: true })
        .eq('journey_id', checkin.journey_id)

      const isMajority = memberCount && newFlagCount / memberCount > 0.5

      await adminSupabase
        .from('checkins')
        .update({ flag_count: newFlagCount, ...(isMajority ? { admin_flagged: true } : {}) })
        .eq('id', req.params.id)

      if (isMajority) {
        // Reset both per-journey and global streak on majority flag
        await adminSupabase
          .from('journey_members')
          .update({ current_streak: 0 })
          .eq('journey_id', checkin.journey_id)
          .eq('user_id', checkin.user_id)

        await adminSupabase
          .from('users')
          .update({ current_streak: 0, global_streak: 0 })
          .eq('id', checkin.user_id)

        await sendPush(
          checkin.user_id,
          'Check-in flagged',
          'The majority of your journey members flagged your check-in. Your streak has been reset.',
          { journey_id: checkin.journey_id }
        )
      }
    }

    // Recalculate reputation from full history (formula-based)
    await updateReputation(checkin.user_id)

    res.json({ success: true })
  } catch (err) { next(err) }
})

// GET /checkins/journey/:journeyId — check-ins for a journey (today_only=true for feed, all for heatmap)
router.get('/journey/:journeyId', requireAuth, async (req, res, next) => {
  try {
    const { limit = 50, offset = 0, today_only } = req.query
    let query = adminSupabase
      .from('checkins')
      .select('*, user:users(id, full_name, avatar_url, avatar_seed, avatar_bg)')
      .eq('journey_id', req.params.journeyId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (today_only === 'true') {
      query = query.eq('checkin_date', new Date().toISOString().split('T')[0])
    }

    const { data, error } = await query
    if (error) throw error

    // Attach current user's verdict for each check-in (so UI can show permanent state)
    const checkinIds = (data || []).map(c => c.id)
    let myVerdicts = {}
    if (checkinIds.length > 0) {
      const { data: verdicts } = await adminSupabase
        .from('checkin_verifications')
        .select('checkin_id, verdict')
        .eq('verifier_id', req.user.id)
        .in('checkin_id', checkinIds)
      for (const v of (verdicts || [])) myVerdicts[v.checkin_id] = v.verdict
    }

    const enriched = (data || []).map(c => ({ ...c, my_verdict: myVerdicts[c.id] || null }))
    res.json({ success: true, checkins: enriched })
  } catch (err) { next(err) }
})

// GET /checkins/me — all check-ins by the current user across all their journeys
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { limit = 50, offset = 0 } = req.query
    const { data, error } = await adminSupabase
      .from('checkins')
      .select('*, journey:journeys(id, title, category, cover_image_url)')
      .eq('user_id', req.user.id)
      .order('checkin_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (error) throw error
    res.json({ success: true, checkins: data })
  } catch (err) { next(err) }
})

module.exports = router
