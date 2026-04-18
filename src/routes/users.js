const router = require('express').Router()
const logger = require('../config/logger')
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')

// GET /users/me — get current user profile with stats
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0]
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split('T')[0]

    const { data: user, error } = await adminSupabase
      .from('users')
      .select('id, full_name, avatar_url, avatar_seed, avatar_bg, bio, country, region, plan, streak_total, longest_streak, current_streak, global_streak, global_streak_date, journeys_completed, reputation_score, total_approvals_received, total_flags_received, notification_enabled, streak_mode, created_at, badges(key, name, earned_at)')
      .eq('id', req.user.id)
      .single()

    if (error || !user) {
      // Profile row missing — upsert it now from the auth user data so the app can continue
      logger.warn('[USERS] Profile missing — auto-creating', { userId: req.user.id })
      const { data: created, error: upsertErr } = await adminSupabase
        .from('users')
        .upsert({
          id: req.user.id,
          full_name: req.user.user_metadata?.full_name || req.user.email?.split('@')[0] || 'User',
          country: 'Nigeria',
          region: 'Lagos',
        }, { onConflict: 'id' })
        .select('id, full_name, avatar_url, avatar_seed, avatar_bg, bio, country, region, plan, streak_total, longest_streak, current_streak, journeys_completed, reputation_score, notification_enabled, streak_mode, created_at')
        .single()

      if (upsertErr) {
        logger.error('[USERS] Auto-create failed', { userId: req.user.id, error: upsertErr.message })
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } })
      }

      return res.json({ success: true, data: { user: { ...created, current_streak: 0, badges: [] } } })
    }

    // current_streak is written directly by recalculateStreak on every check-in and at midnight.
    // Fall back to global_streak for rows that haven't been migrated yet.
    const currentStreak = user.current_streak ?? user.global_streak ?? 0

    logger.info('[USERS] Fetched profile', { userId: req.user.id, currentStreak })
    res.json({ success: true, data: { user: { ...user, current_streak: currentStreak } } })
  } catch (err) { next(err) }
})

// PATCH /users/me — update own profile
router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const allowed = ['full_name', 'bio', 'avatar_url', 'avatar_seed', 'avatar_bg', 'phone', 'country', 'region', 'streak_mode', 'notification_enabled', 'timezone']
    const updates = {}
    for (const key of allowed) {
      // Allow null explicitly — used to clear avatar_seed when a photo is uploaded
      if (key in req.body) updates[key] = req.body[key]
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'No valid fields to update.' }
      })
    }

    logger.info('[USERS] Updating profile', { userId: req.user.id, fields: Object.keys(updates) })

    const { data, error } = await adminSupabase
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single()

    if (error) throw error

    logger.info('[USERS] Profile updated', { userId: req.user.id })
    res.json({ success: true, data: { user: data } })
  } catch (err) { next(err) }
})

// DELETE /users/me — permanently delete own account and all associated data
router.delete('/me', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id
    logger.warn('[USERS] Account deletion requested', { userId })

    // 1. Categorise journeys this user created:
    //    - Active journeys with other members → transfer creator, keep journey running
    //    - Everything else → delete
    const { data: createdJourneys } = await adminSupabase
      .from('journeys')
      .select('id, status, current_participants')
      .eq('creator_id', userId)

    const transferIds = []  // active journeys with other members — preserve
    const deleteIds = []    // journeys to fully wipe

    for (const j of createdJourneys || []) {
      if (j.status === 'active' && j.current_participants > 1) {
        transferIds.push(j.id)
      } else {
        deleteIds.push(j.id)
      }
    }

    // 2. Transfer creator_id to the next member for preserved journeys
    for (const journeyId of transferIds) {
      const { data: nextMember } = await adminSupabase
        .from('journey_members')
        .select('user_id')
        .eq('journey_id', journeyId)
        .neq('user_id', userId)
        .limit(1)
        .single()

      if (nextMember) {
        await adminSupabase.from('journeys')
          .update({ creator_id: nextMember.user_id })
          .eq('id', journeyId)
        await adminSupabase.from('journey_members')
          .update({ role: 'creator' })
          .eq('journey_id', journeyId)
          .eq('user_id', nextMember.user_id)
      }
    }

    // 3. Wipe child data for journeys being deleted
    if (deleteIds.length > 0) {
      const { data: journeyCheckins } = await adminSupabase
        .from('checkins').select('id').in('journey_id', deleteIds)
      const checkinIds = (journeyCheckins || []).map(c => c.id)
      if (checkinIds.length > 0) {
        await adminSupabase.from('checkin_verifications').delete().in('checkin_id', checkinIds)
      }
      await adminSupabase.from('checkins').delete().in('journey_id', deleteIds)
      await adminSupabase.from('journey_members').delete().in('journey_id', deleteIds)
      await adminSupabase.from('messages').delete().in('journey_id', deleteIds)
      await adminSupabase.from('milestones').delete().in('journey_id', deleteIds)
      await adminSupabase.from('stakes').delete().in('journey_id', deleteIds)
      await adminSupabase.from('journeys').delete().in('id', deleteIds)
    }

    // 4. Remove user from any other journeys they're a member of
    await adminSupabase.from('journey_members').delete().eq('user_id', userId)

    // 5. Delete user's own checkin verifications, checkins, messages, badges, stakes
    await adminSupabase.from('checkin_verifications').delete().eq('verifier_id', userId)
    const { data: userCheckins } = await adminSupabase
      .from('checkins').select('id').eq('user_id', userId)
    if ((userCheckins || []).length > 0) {
      await adminSupabase.from('checkin_verifications').delete()
        .in('checkin_id', userCheckins.map(c => c.id))
    }
    await adminSupabase.from('checkins').delete().eq('user_id', userId)
    await adminSupabase.from('messages').delete().eq('sender_id', userId)
    await adminSupabase.from('badges').delete().eq('user_id', userId)
    await adminSupabase.from('stakes').delete().eq('user_id', userId)

    // 6. Delete profile row
    const { error: profileError } = await adminSupabase
      .from('users').delete().eq('id', userId)
    if (profileError) throw profileError

    // 7. Delete Supabase auth user
    await adminSupabase.auth.admin.deleteUser(userId)

    logger.warn('[USERS] Account fully deleted', { userId, transferredJourneys: transferIds.length, deletedJourneys: deleteIds.length })
    res.json({ success: true })
  } catch (err) { next(err) }
})

// GET /users/:id — get a public user profile
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { data: user, error } = await adminSupabase
      .from('users')
      .select('id, full_name, avatar_url, avatar_seed, avatar_bg, bio, country, region, streak_total, longest_streak, journeys_completed, reputation_score, created_at, badges(*)')
      .eq('id', req.params.id)
      .single()

    if (error || !user) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } })
    }

    logger.info('[USERS] Fetched public profile', { requestedId: req.params.id })
    res.json({ success: true, data: { user } })
  } catch (err) { next(err) }
})

module.exports = router
