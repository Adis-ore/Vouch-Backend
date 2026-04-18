const router = require('express').Router()
const { adminSupabase } = require('../lib/supabase')
const { requireAdmin } = require('../middleware/adminAuth')
const { processStakeRefund } = require('../lib/refund')
const { initiateRefund } = require('../lib/paystack')

router.use(requireAdmin)

// GET /admin/stats — dashboard summary counts
router.get('/stats', async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0]
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString()
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString()

    const [
      { count: totalUsers },
      { count: activeJourneys },
      { count: checkinsToday },
      { count: journeysCompleted },
      { data: stakesHeld },
      { data: forfeitures },
      { count: newUsersThisWeek },
      { count: newUsersLastWeek },
    ] = await Promise.all([
      adminSupabase.from('users').select('*', { count: 'exact', head: true }),
      adminSupabase.from('journeys').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      adminSupabase.from('checkins').select('*', { count: 'exact', head: true }).eq('checkin_date', today),
      adminSupabase.from('journeys').select('*', { count: 'exact', head: true }).eq('status', 'completed'),
      adminSupabase.from('stakes').select('amount').eq('status', 'held'),
      adminSupabase.from('stakes').select('amount').eq('status', 'forfeited'),
      adminSupabase.from('users').select('*', { count: 'exact', head: true }).gte('created_at', weekAgo),
      adminSupabase.from('users').select('*', { count: 'exact', head: true }).gte('created_at', twoWeeksAgo).lt('created_at', weekAgo),
    ])

    const stakesHeldTotal = (stakesHeld || []).reduce((s, r) => s + Number(r.amount || 0), 0)
    const forfeitureTotal = (forfeitures || []).reduce((s, r) => s + Number(r.amount || 0), 0)

    res.json({
      success: true,
      data: {
        totalUsers: totalUsers ?? 0,
        activeJourneys: activeJourneys ?? 0,
        checkinsToday: checkinsToday ?? 0,
        journeysCompleted: journeysCompleted ?? 0,
        stakesHeld: stakesHeldTotal,
        forfeitureRevenue: forfeitureTotal,
        newUsersThisWeek: newUsersThisWeek ?? 0,
        newUsersLastWeek: newUsersLastWeek ?? 0,
      },
    })
  } catch (err) { next(err) }
})

// GET /admin/stats/charts — signup + checkin time-series for last 14 days
router.get('/stats/charts', async (req, res, next) => {
  try {
    const days = 14
    const since = new Date(Date.now() - days * 86400000).toISOString()

    const [{ data: signups }, { data: checkins }, { data: journeyStatuses }] = await Promise.all([
      adminSupabase.from('users').select('created_at').gte('created_at', since),
      adminSupabase.from('checkins').select('checkin_date').gte('created_at', since),
      adminSupabase.from('journeys').select('status'),
    ])

    // Bucket signups by day
    const signupMap = {}
    for (const u of (signups || [])) {
      const d = u.created_at.split('T')[0]
      signupMap[d] = (signupMap[d] || 0) + 1
    }
    const signupChart = Array.from({ length: days }, (_, i) => {
      const d = new Date(Date.now() - (days - 1 - i) * 86400000)
      const key = d.toISOString().split('T')[0]
      return { date: key.slice(5), users: signupMap[key] || 0 }
    })

    // Bucket checkins by day
    const checkinMap = {}
    for (const c of (checkins || [])) {
      const d = c.checkin_date
      checkinMap[d] = (checkinMap[d] || 0) + 1
    }
    const checkinChart = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(Date.now() - (6 - i) * 86400000)
      const key = d.toISOString().split('T')[0]
      return { date: key.slice(5), checkins: checkinMap[key] || 0 }
    })

    // Journey status breakdown
    const statusCounts = {}
    for (const j of (journeyStatuses || [])) {
      statusCounts[j.status] = (statusCounts[j.status] || 0) + 1
    }
    const COLORS = { active: '#3ECFAA', open: '#5B9CF6', completed: '#E8A838', abandoned: '#E85D4A' }
    const journeyStatusChart = Object.entries(statusCounts).map(([name, value]) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      value,
      color: COLORS[name] || '#888',
    }))

    res.json({ success: true, data: { signupChart, checkinChart, journeyStatusChart } })
  } catch (err) { next(err) }
})

// GET /admin/activity — recent platform activity for dashboard feed
router.get('/activity', async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 10
    const { data: notifications } = await adminSupabase
      .from('admin_notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)
    res.json({ success: true, data: notifications || [] })
  } catch (err) { next(err) }
})

// GET /admin/stakes — all held stakes with user + journey info
router.get('/stakes', async (req, res, next) => {
  try {
    const { status = 'held', limit = 50, offset = 0 } = req.query
    const query = adminSupabase
      .from('stakes')
      .select('*, user:users(id, full_name, email:auth_email), journey:journeys(id, title, end_date)')
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (status !== 'all') query.eq('status', status)

    const { data, count } = await query
    res.json({ success: true, data: data || [], count })
  } catch (err) { next(err) }
})

// GET /admin/forfeitures — forfeited stakes
router.get('/forfeitures', async (req, res, next) => {
  try {
    const { limit = 50, offset = 0 } = req.query
    const { data } = await adminSupabase
      .from('stakes')
      .select('*, user:users(id, full_name), journey:journeys(id, title)')
      .eq('status', 'forfeited')
      .order('forfeited_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)
    res.json({ success: true, data: data || [] })
  } catch (err) { next(err) }
})

// GET /admin/refunds — returned stakes
router.get('/refunds', async (req, res, next) => {
  try {
    const { limit = 50, offset = 0 } = req.query
    const { data } = await adminSupabase
      .from('stakes')
      .select('*, user:users(id, full_name), journey:journeys(id, title)')
      .eq('status', 'returned')
      .order('returned_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)
    res.json({ success: true, data: data || [] })
  } catch (err) { next(err) }
})

// GET /admin/refund-failures — failed refunds pending resolution
router.get('/refund-failures', async (req, res, next) => {
  try {
    const { data } = await adminSupabase
      .from('refund_failures')
      .select('*, stake:stakes(id, amount, paystack_transaction_id, refund_amount, refund_percent), user:users(id, full_name), journey:journeys(id, title)')
      .eq('resolved', false)
      .order('attempted_at', { ascending: false })
    res.json({ success: true, data: data || [] })
  } catch (err) { next(err) }
})

// POST /admin/refund-failures/:id/retry — retry a failed refund
router.post('/refund-failures/:id/retry', async (req, res, next) => {
  try {
    const { data: failure } = await adminSupabase
      .from('refund_failures')
      .select('*, stake:stakes(*)')
      .eq('id', req.params.id)
      .single()

    if (!failure) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } })

    const stake = failure.stake
    if (!stake || stake.status !== 'refund_failed') {
      return res.status(400).json({ success: false, error: { code: 'NOT_RETRYABLE' } })
    }

    try {
      const result = await initiateRefund({
        transaction: stake.paystack_transaction_id,
        amount: stake.refund_amount * 100,
      })

      await adminSupabase.from('stakes').update({
        status: 'returned',
        paystack_refund_id: result?.id ?? null,
        returned_at: new Date().toISOString(),
      }).eq('id', stake.id)

      await adminSupabase.from('refund_failures').update({
        resolved: true,
        resolved_at: new Date().toISOString(),
      }).eq('id', failure.id)

      res.json({ success: true })
    } catch (err) {
      await adminSupabase.from('refund_failures').update({
        error_message: err.message,
        attempted_at: new Date().toISOString(),
      }).eq('id', failure.id)
      res.status(502).json({ success: false, error: { code: 'PAYSTACK_ERROR', message: err.message } })
    }
  } catch (err) { next(err) }
})

// GET /admin/users — all users
router.get('/users', async (req, res, next) => {
  try {
    const { search, limit = 50, offset = 0 } = req.query
    let query = adminSupabase
      .from('users')
      .select('id, full_name, country, region, plan, reputation_score, current_streak, journeys_completed, created_at, avatar_url', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (search) query = query.ilike('full_name', `%${search}%`)

    const { data, count } = await query
    res.json({ success: true, data: data || [], count })
  } catch (err) { next(err) }
})

// GET /admin/journeys — all journeys with creator info
router.get('/journeys', async (req, res, next) => {
  try {
    const { status, search, limit = 50, offset = 0 } = req.query
    let query = adminSupabase
      .from('journeys')
      .select('id, title, category, status, current_participants, max_participants, stake_amount, start_date, end_date, country, is_private, creator:users!creator_id(id, full_name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (status && status !== 'all') query = query.eq('status', status)
    if (search) query = query.ilike('title', `%${search}%`)

    const { data, count } = await query
    res.json({ success: true, data: data || [], count })
  } catch (err) { next(err) }
})

module.exports = router
