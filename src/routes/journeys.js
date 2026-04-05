const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')
const { scoreJourney } = require('../lib/matching')
const { initializePayment } = require('../lib/paystack')
const { sendPush } = require('../lib/push')

// GET /journeys/discover — ranked open journeys for current user
router.get('/discover', requireAuth, async (req, res, next) => {
  try {
    const { category, country_only, limit = 20, offset = 0 } = req.query

    const { data: currentUser } = await adminSupabase
      .from('users')
      .select('country, region')
      .eq('id', req.user.id)
      .single()

    let query = adminSupabase
      .from('journeys')
      .select('*, creator:users!creator_id(id, full_name, avatar_url, reputation_score, country, region), journey_members(count)')
      .eq('status', 'open')

    if (category) query = query.eq('category', category)
    if (country_only === 'true') query = query.eq('country', currentUser.country)

    const { data: journeys, error } = await query
      .order('is_featured', { ascending: false })
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (error) throw error

    const scored = journeys
      .map(j => ({ ...j, _score: scoreJourney(j, currentUser) }))
      .sort((a, b) => b._score - a._score)
      .map(({ _score, ...j }) => j)

    res.json({ success: true, journeys: scored })
  } catch (err) { next(err) }
})

// POST /journeys — create a new journey
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const {
      title, description, category, cover_image_url,
      duration_days, start_date, max_participants,
      milestones, stake_amount
    } = req.body

    if (!title || !category || !duration_days || !milestones?.length) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'title, category, duration_days and milestones are required' }
      })
    }

    const { data: creator } = await adminSupabase
      .from('users')
      .select('country, region')
      .eq('id', req.user.id)
      .single()

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
        callback_url: `${process.env.FRONTEND_URL}/payment-complete`
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
    const { data: journey, error } = await adminSupabase
      .from('journeys')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (error || !journey) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Journey not found' } })
    }
    if (journey.status !== 'open') {
      return res.status(400).json({ success: false, error: { code: 'JOURNEY_NOT_OPEN', message: 'Journey is not accepting members' } })
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

    // Activate if now full
    if (newCount >= journey.max_participants) {
      const today = new Date().toISOString().split('T')[0]
      const endDate = new Date()
      endDate.setDate(endDate.getDate() + journey.duration_days)
      await adminSupabase.from('journeys').update({
        status: 'active',
        start_date: today,
        end_date: endDate.toISOString().split('T')[0]
      }).eq('id', journey.id)
    }

    let payment_url = null
    if (amount > 0) {
      const { data: userData } = await adminSupabase.auth.admin.getUserById(req.user.id)
      const { authorization_url, reference } = await initializePayment({
        email: userData.user.email,
        amount: amount * 100,
        metadata: { journey_id: journey.id, user_id: req.user.id, type: 'member' },
        callback_url: `${process.env.FRONTEND_URL}/payment-complete`
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

    // Notify creator
    const { data: joiner } = await adminSupabase
      .from('users').select('full_name').eq('id', req.user.id).single()
    await sendPush(
      journey.creator_id,
      'New member joined',
      `${joiner.full_name} joined your journey "${journey.title}"`,
      { journey_id: journey.id }
    )

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

// POST /journeys/:id/leave — member leaves (forfeits stake if any)
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
        error: { code: 'CREATOR_CANNOT_LEAVE', message: 'Creators must cancel the journey, not leave it' }
      })
    }

    // Forfeit any held stake
    await adminSupabase
      .from('stakes')
      .update({ status: 'forfeited', forfeited_at: new Date().toISOString() })
      .eq('journey_id', journey.id)
      .eq('user_id', req.user.id)
      .eq('status', 'held')

    await adminSupabase
      .from('journey_members')
      .update({ stake_status: 'forfeited' })
      .eq('journey_id', journey.id)
      .eq('user_id', req.user.id)

    await adminSupabase
      .from('journey_members')
      .delete()
      .eq('journey_id', journey.id)
      .eq('user_id', req.user.id)

    await adminSupabase
      .from('journeys')
      .update({ current_participants: journey.current_participants - 1 })
      .eq('id', journey.id)

    const { data: leavingUser } = await adminSupabase
      .from('users').select('full_name').eq('id', req.user.id).single()

    await adminSupabase.from('messages').insert({
      journey_id: journey.id,
      sender_id: req.user.id,
      content: `${leavingUser.full_name} has left the journey.`,
      type: 'system'
    })

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

    const today = new Date()
    const start = new Date(journey.start_date)
    const daysElapsed = Math.max(0, Math.floor((today - start) / (1000 * 60 * 60 * 24)))
    const progressPercent = Math.min(100, Math.round((daysElapsed / journey.duration_days) * 100))

    res.json({
      success: true,
      journey: { ...journey, days_elapsed: daysElapsed, progress_percent: progressPercent }
    })
  } catch (err) { next(err) }
})

module.exports = router
