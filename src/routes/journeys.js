const router = require('express').Router()
const logger = require('../config/logger')
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')
const { scoreJourney } = require('../lib/matching')
const { initializePayment } = require('../lib/paystack')
const { sendPush } = require('../lib/push')
const { writeHistory } = require('../lib/historyHelper')
const { processStakeRefund } = require('../lib/refund')
const { canCreateOrJoinJourney, PLAN_LIMITS } = require('../lib/planLimits')

// GET /journeys/mine — journeys the current user is a member of
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0]

    const [membershipResult, checkinsResult, pastResult] = await Promise.all([
      // Active memberships only (status = 'active')
      adminSupabase
        .from('journey_members')
        .select('*, journey:journeys(id, title, category, status, duration_days, start_date, current_participants, max_participants, stake_amount, cover_image_url, creator_id, creator:users!creator_id(id, full_name, avatar_url))')
        .eq('user_id', req.user.id)
        .eq('status', 'active'),
      adminSupabase
        .from('checkins')
        .select('journey_id')
        .eq('user_id', req.user.id)
        .eq('checkin_date', today),
      // Past memberships (completed, abandoned, auto_abandoned)
      adminSupabase
        .from('journey_members')
        .select('*, journey:journeys(id, title, category, duration_days, stake_amount, status)')
        .eq('user_id', req.user.id)
        .in('status', ['completed', 'abandoned', 'auto_abandoned'])
        .order('completed_at', { ascending: false, nullsFirst: false })
        .limit(50),
    ])

    if (membershipResult.error) throw membershipResult.error

    const memberships = membershipResult.data || []
    const todayCheckins = checkinsResult.data || []
    const pastMemberships = pastResult.data || []

    const checkedInTodaySet = new Set(todayCheckins.map(c => c.journey_id))

    const active = []
    for (const m of memberships) {
      const j = m.journey
      if (!j) continue
      if (!['open', 'active'].includes(j.status)) continue

      let daysElapsed = 0, progressPercent = 0
      if (j.start_date) {
        const rawDays = Math.floor((new Date() - new Date(j.start_date)) / 86400000)
        daysElapsed = Math.min(j.duration_days, Math.max(1, rawDays + 1))
        progressPercent = Math.min(100, Math.round((daysElapsed / j.duration_days) * 100))
      }

      active.push({
        ...j,
        days_elapsed: daysElapsed,
        progress_percent: progressPercent,
        my_role: m.role,
        my_checkins: m.total_checkins || 0,
        my_streak: m.current_streak || 0,
        checked_in_today: checkedInTodaySet.has(j.id),
      })
    }

    // Fetch stake outcomes for past journeys
    const pastJourneyIds = pastMemberships.map(m => m.journey_id).filter(Boolean)
    let stakeMap = {}
    if (pastJourneyIds.length > 0) {
      const { data: stakes } = await adminSupabase
        .from('stakes')
        .select('journey_id, status, refund_percent')
        .eq('user_id', req.user.id)
        .in('journey_id', pastJourneyIds)
      for (const s of (stakes || [])) stakeMap[s.journey_id] = s
    }

    const past = pastMemberships
      .map(m => {
        const j = m.journey || {}
        const stake = stakeMap[m.journey_id]
        const stakeStatus = stake?.status
        const stake_outcome = stakeStatus === 'refunded' ? 'returned'
          : stakeStatus === 'forfeited' ? 'forfeited' : null
        const ended_at = m.completed_at || m.abandoned_at
        return {
          id: m.journey_id,
          history_id: m.id,
          title: j.title,
          category: j.category,
          duration_days: j.duration_days,
          stake_amount: j.stake_amount,
          status: m.status,
          my_role: m.role,
          total_checkins: m.total_checkins || 0,
          stake_outcome,
          ended_at,
        }
      })
      .sort((a, b) => {
        if (!a.ended_at && !b.ended_at) return 0
        if (!a.ended_at) return 1
        if (!b.ended_at) return -1
        return new Date(b.ended_at) - new Date(a.ended_at)
      })

    logger.info('[JOURNEYS] Fetched user journeys', { userId: req.user.id, active: active.length, past: past.length })
    res.json({ success: true, data: { active, past } })
  } catch (err) { next(err) }
})

// GET /journeys/discover — ranked open journeys for current user
router.get('/discover', requireAuth, async (req, res, next) => {
  try {
    const { category, country_only, limit = 20, offset = 0 } = req.query
    const { isJoinWindowOpen, getJoinWindowLabel } = require('../lib/joinWindow')

    const [{ data: currentUser }, { data: myMemberships }] = await Promise.all([
      adminSupabase.from('users').select('country, region, plan').eq('id', req.user.id).single(),
      adminSupabase.from('journey_members').select('journey_id').eq('user_id', req.user.id),
    ])
    const myJourneyIds = (myMemberships || []).map(m => m.journey_id)

    // Fetch open + active journeys (active ones may still be in join window)
    let query = adminSupabase
      .from('journeys')
      .select('*, creator:users!creator_id(id, full_name, avatar_url, reputation_score, country, region), journey_members(count)')
      .in('status', ['open', 'active'])
      .neq('is_private', true)   // never show private journeys; NULL treated as public

    if (myJourneyIds.length > 0) query = query.not('id', 'in', `(${myJourneyIds.join(',')})`)
    if (category) query = query.eq('category', category)
    if (country_only === 'true') query = query.eq('country', currentUser?.country)

    const { data: journeys, error } = await query
      .order('is_featured', { ascending: false })
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) * 3 - 1) // fetch extra, filter below

    if (error) throw error

    // Filter to only journeys where the join window is still open
    const joinable = journeys.filter(j => isJoinWindowOpen(j))

    // Annotate each journey with join window label for the client
    const annotated = joinable.map(j => ({
      ...j,
      join_window: getJoinWindowLabel(j),
    }))

    const scored = annotated
      .map(j => ({ ...j, _score: scoreJourney(j, currentUser) }))
      .sort((a, b) => b._score - a._score)
      .map(({ _score, ...j }) => j)
      .slice(0, Number(limit))

    res.json({ success: true, journeys: scored })
  } catch (err) { next(err) }
})

// POST /journeys — create a new journey
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const {
      title, description, category, cover_image_url,
      duration_days, start_date, max_participants,
      milestones, stake_amount, is_private = false
    } = req.body

    if (!title || !category || !duration_days || !milestones?.length) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'title, category, duration_days and milestones are required' }
      })
    }

    const { data: creator } = await adminSupabase
      .from('users')
      .select('country, region, plan')
      .eq('id', req.user.id)
      .single()

    // Enforce per-plan active journey limit
    const { allowed, count: activeCount, limit: planLimit } = await canCreateOrJoinJourney(req.user.id, creator?.plan ?? 'free')
    if (!allowed) {
      return res.status(403).json({
        success: false,
        error: { code: 'JOURNEY_LIMIT_REACHED', message: `You can only be in ${planLimit} active journeys on the ${creator?.plan ?? 'free'} plan. Complete or leave a journey to create a new one.` }
      })
    }

    const amount = parseFloat(stake_amount) || 0
    const initialStatus = amount > 0 ? 'pending_payment' : 'open'

    const { data: journey, error: journeyError } = await adminSupabase
      .from('journeys')
      .insert({
        creator_id: req.user.id,
        title,
        description,
        category,
        cover_image_url,
        duration_days: parseInt(duration_days),
        max_participants: parseInt(max_participants) || 2,
        current_participants: 1,
        start_date: start_date || null,
        status: initialStatus,
        stake_amount: amount,
        is_private: is_private === true || is_private === 'true',
        country: creator.country,
        region: creator.region
      })
      .select()
      .single()

    if (journeyError) throw journeyError

    // Add creator as first member
    await adminSupabase.from('journey_members').insert({
      journey_id: journey.id,
      user_id: req.user.id,
      role: 'creator',
      stake_status: amount > 0 ? 'pending' : 'none'
    })

    // Create milestones — first one unlocked immediately
    const milestoneRows = milestones.map((m, i) => ({
      journey_id: journey.id,
      week_number: i + 1,
      title: m.title,
      description: m.description || null,
      is_unlocked: i === 0
    }))
    await adminSupabase.from('milestones').insert(milestoneRows)

    let payment_url = null
    if (amount > 0) {
      const { data: userData } = await adminSupabase.auth.admin.getUserById(req.user.id)
      const { authorization_url, reference } = await initializePayment({
        email: userData.user.email,
        amount: amount * 100,
        metadata: { journey_id: journey.id, user_id: req.user.id, type: 'creator' },
        callback_url: `vouch://payment-complete`
      })
      payment_url = authorization_url
      await adminSupabase.from('stakes').insert({
        journey_id: journey.id,
        user_id: req.user.id,
        amount,
        payment_reference: reference,
        status: 'pending'
      })
    }

    res.status(201).json({ success: true, journey, payment_url })
  } catch (err) { next(err) }
})

// POST /journeys/:id/join — join an open journey
router.post('/:id/join', requireAuth, async (req, res, next) => {
  try {
    const { isJoinWindowOpen } = require('../lib/joinWindow')

    const [{ data: journey, error }, { data: currentUser }] = await Promise.all([
      adminSupabase.from('journeys').select('*').eq('id', req.params.id).single(),
      adminSupabase.from('users').select('plan').eq('id', req.user.id).single(),
    ])

    if (error || !journey) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Journey not found' } })
    }
    if (!['open', 'active'].includes(journey.status)) {
      return res.status(400).json({ success: false, error: { code: 'JOURNEY_NOT_OPEN', message: 'Journey is not accepting members' } })
    }
    if (!isJoinWindowOpen(journey)) {
      return res.status(400).json({ success: false, error: { code: 'JOIN_WINDOW_CLOSED', message: 'The join window for this journey has closed' } })
    }
    if (journey.is_private) {
      const userPlan = currentUser?.plan ?? 'free'
      if (!['pro', 'elite'].includes(userPlan)) {
        return res.status(403).json({ success: false, error: { code: 'PLAN_REQUIRED', message: 'Upgrade to Pro or Elite to join private journeys' } })
      }
    }
    if (journey.current_participants >= journey.max_participants) {
      return res.status(400).json({ success: false, error: { code: 'JOURNEY_FULL', message: 'Journey is full' } })
    }
    if (journey.creator_id === req.user.id) {
      return res.status(400).json({ success: false, error: { code: 'SELF_JOIN', message: 'You cannot join your own journey' } })
    }

    const { data: existing } = await adminSupabase
      .from('journey_members')
      .select('id')
      .eq('journey_id', journey.id)
      .eq('user_id', req.user.id)
      .single()
    if (existing) {
      return res.status(400).json({ success: false, error: { code: 'ALREADY_MEMBER', message: 'Already a member of this journey' } })
    }

    // Enforce per-plan active journey limit (counts jm.status = 'active' slots)
    const userPlan = currentUser?.plan ?? 'free'
    const { allowed: canJoin, limit: joinLimit } = await canCreateOrJoinJourney(req.user.id, userPlan)
    if (!canJoin) {
      return res.status(403).json({
        success: false,
        error: { code: 'JOURNEY_LIMIT_REACHED', message: `You can only be in ${joinLimit} active journeys on the ${userPlan} plan. Complete or leave a journey to join more.` }
      })
    }

    const amount = parseFloat(journey.stake_amount) || 0

    await adminSupabase.from('journey_members').insert({
      journey_id: journey.id,
      user_id: req.user.id,
      role: 'member',
      stake_status: amount > 0 ? 'pending' : 'none'
    })

    const newCount = journey.current_participants + 1
    await adminSupabase
      .from('journeys')
      .update({ current_participants: newCount })
      .eq('id', journey.id)

    // Activate as soon as 2+ members are in (don't wait for full capacity)
    let journeyStarted = false
    if (newCount >= 2) {
      const today = new Date().toISOString().split('T')[0]
      const endDate = new Date()
      endDate.setDate(endDate.getDate() + journey.duration_days)
      await adminSupabase.from('journeys').update({
        status: 'active',
        start_date: today,
        end_date: endDate.toISOString().split('T')[0]
      }).eq('id', journey.id)
      journeyStarted = true
    }

    let payment_url = null
    if (amount > 0) {
      const { data: userData } = await adminSupabase.auth.admin.getUserById(req.user.id)
      const { authorization_url, reference } = await initializePayment({
        email: userData.user.email,
        amount: amount * 100,
        metadata: { journey_id: journey.id, user_id: req.user.id, type: 'member' },
        callback_url: `vouch://payment-complete`
      })
      payment_url = authorization_url
      await adminSupabase.from('stakes').insert({
        journey_id: journey.id,
        user_id: req.user.id,
        amount,
        payment_reference: reference,
        status: 'pending'
      })
    }

    // Notify creator a new member joined
    const { data: joiner } = await adminSupabase
      .from('users').select('full_name').eq('id', req.user.id).single()

    if (journey.creator_id !== req.user.id) {
      await adminSupabase.from('notifications').insert({
        user_id: journey.creator_id,
        type: 'member_joined',
        title: `${joiner?.full_name || 'Someone'} joined your journey`,
        body: `"${journey.title}" now has ${newCount} members.`,
        data: { route: 'journey', journey_id: journey.id, tab: 'members' },
        read: false,
      }).catch(() => {})
      await sendPush(journey.creator_id, 'New member joined',
        `${joiner?.full_name || 'Someone'} joined your journey "${journey.title}"`,
        { journey_id: journey.id }
      )
    }

    // If journey just started, notify all existing members
    if (journeyStarted) {
      const { data: allMembers } = await adminSupabase
        .from('journey_members').select('user_id').eq('journey_id', journey.id)
      const notifRows = (allMembers || []).map(m => ({
        user_id: m.user_id,
        type: 'journey_started',
        title: 'Your journey has started',
        body: `"${journey.title}" is now active. Check in today to begin your streak.`,
        data: { route: 'journey', journey_id: journey.id, tab: 'overview' },
        read: false,
      }))
      if (notifRows.length) adminSupabase.from('notifications').insert(notifRows).then(() => {}).catch(() => {})
    }

    res.json({ success: true, payment_url })
  } catch (err) { next(err) }
})

// POST /journeys/:id/start — creator manually starts the journey
router.post('/:id/start', requireAuth, async (req, res, next) => {
  try {
    const { data: journey } = await adminSupabase
      .from('journeys').select('*').eq('id', req.params.id).single()

    if (!journey || journey.creator_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } })
    }
    if (journey.status !== 'open') {
      return res.status(400).json({ success: false, error: { code: 'CANNOT_START' } })
    }
    if (journey.current_participants < 2) {
      return res.status(400).json({
        success: false,
        error: { code: 'NOT_ENOUGH_MEMBERS', message: 'Need at least 2 members to start' }
      })
    }

    const today = new Date().toISOString().split('T')[0]
    const endDate = new Date()
    endDate.setDate(endDate.getDate() + journey.duration_days)

    await adminSupabase.from('journeys').update({
      status: 'active',
      start_date: today,
      end_date: endDate.toISOString().split('T')[0]
    }).eq('id', journey.id)

    res.json({ success: true })
  } catch (err) { next(err) }
})

// POST /journeys/:id/leave — member voluntarily leaves (forfeits stake if any)
router.post('/:id/leave', requireAuth, async (req, res, next) => {
  try {
    const { data: journey } = await adminSupabase
      .from('journeys').select('*').eq('id', req.params.id).single()

    if (!journey) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } })
    }
    if (journey.creator_id === req.user.id) {
      return res.status(400).json({
        success: false,
        error: { code: 'CREATOR_CANNOT_LEAVE', message: 'Creators must abandon the journey, not leave it.' }
      })
    }

    const { data: member } = await adminSupabase
      .from('journey_members').select('*')
      .eq('journey_id', journey.id).eq('user_id', req.user.id).single()

    // Forfeit any held stake
    await adminSupabase
      .from('stakes')
      .update({ status: 'forfeited', forfeited_at: new Date().toISOString() })
      .eq('journey_id', journey.id).eq('user_id', req.user.id).eq('status', 'held')

    const completionPct = journey.duration_days > 0
      ? Math.round(((member?.total_checkins || 0) / journey.duration_days) * 100) : 0

    // Mark member record as abandoned (keep for history/stats), then write history
    await adminSupabase
      .from('journey_members')
      .update({ status: 'abandoned', abandoned_at: new Date().toISOString(), abandoned_completion_percent: completionPct })
      .eq('journey_id', journey.id).eq('user_id', req.user.id)

    await writeHistory(req.user.id, journey, member, 'left').catch(() => {})

    await adminSupabase
      .from('journeys')
      .update({ current_participants: Math.max(0, journey.current_participants - 1) })
      .eq('id', journey.id)

    const { data: leavingUser } = await adminSupabase
      .from('users').select('full_name').eq('id', req.user.id).single()

    await adminSupabase.from('messages').insert({
      journey_id: journey.id,
      sender_id: req.user.id,
      content: `${leavingUser?.full_name || 'A member'} has left the journey.`,
      type: 'system'
    })

    res.json({ success: true })
  } catch (err) { next(err) }
})

// POST /journeys/:id/abandon — creator abandons, ends the journey for everyone
router.post('/:id/abandon', requireAuth, async (req, res, next) => {
  try {
    const { data: journey } = await adminSupabase
      .from('journeys').select('*').eq('id', req.params.id).single()

    if (!journey) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } })
    }
    if (journey.creator_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'NOT_CREATOR', message: 'Only the creator can abandon a journey.' } })
    }
    if (!['open', 'active'].includes(journey.status)) {
      return res.status(400).json({ success: false, error: { code: 'ALREADY_ENDED', message: 'Journey has already ended.' } })
    }

    // Get all members before deleting records
    const { data: members } = await adminSupabase
      .from('journey_members')
      .select('user_id, role, stake_status, total_checkins, current_streak, longest_streak')
      .eq('journey_id', journey.id)

    // Mark journey abandoned
    await adminSupabase.from('journeys').update({ status: 'abandoned' }).eq('id', journey.id)

    // Process each member
    for (const m of (members || [])) {
      const completionPercent = journey.duration_days > 0
        ? Math.round(((m.total_checkins || 0) / journey.duration_days) * 100) : 0

      // Tier-based refund based on how far the member got
      if (m.stake_status === 'held') {
        await processStakeRefund({ journeyId: journey.id, userId: m.user_id, completionPercent })
      }

      // Mark member record as abandoned (frees slot for plan limits)
      await adminSupabase
        .from('journey_members')
        .update({ status: 'abandoned', abandoned_at: new Date().toISOString(), abandoned_completion_percent: completionPercent })
        .eq('journey_id', journey.id).eq('user_id', m.user_id)

      await writeHistory(m.user_id, journey, m, 'abandoned').catch(() => {})

      if (m.user_id !== req.user.id) {
        await sendPush(
          m.user_id,
          'Journey abandoned',
          `The creator has abandoned "${journey.title}". Your deposit (if any) has been forfeited.`,
          { journey_id: journey.id, type: 'journey_abandoned' }
        )
      }
    }

    res.json({ success: true })
  } catch (err) { next(err) }
})

// GET /journeys/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { data: journey, error } = await adminSupabase
      .from('journeys')
      .select('*, creator:users!creator_id(*), journey_members(*, user:users(*)), milestones(*)')
      .eq('id', req.params.id)
      .single()

    if (error || !journey) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } })
    }

    let daysElapsed = 0
    let progressPercent = 0
    if (journey.start_date) {
      const start = new Date(journey.start_date)
      const rawDays = Math.floor((new Date() - start) / (1000 * 60 * 60 * 24))
      daysElapsed = Math.min(journey.duration_days, Math.max(1, rawDays + 1))
      progressPercent = Math.min(100, Math.round((daysElapsed / journey.duration_days) * 100))
    }

    res.json({
      success: true,
      journey: { ...journey, days_elapsed: daysElapsed, progress_percent: progressPercent }
    })
  } catch (err) { next(err) }
})

module.exports = router
