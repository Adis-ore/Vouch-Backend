const router = require('express').Router()
const { adminSupabase, anonSupabase } = require('../lib/supabase')
const { requireAdmin } = require('../middleware/adminAuth')
const { processStakeRefund } = require('../lib/refund')
const { initiateRefund } = require('../lib/paystack')

// POST /admin/login — authenticate an admin user
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body
    const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'adisoreoluwa@gmail.com'
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Oreoluwa20!'

    if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect email or password.' } })
    }

    const token = Buffer.from(`${email}:${Date.now()}`).toString('base64')
    res.json({
      success: true,
      data: {
        token,
        user: { email, full_name: 'Admin' },
      },
    })
  } catch (err) { next(err) }
})

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

// GET /admin/users/:id — single user profile + their journeys
router.get('/users/:id', async (req, res, next) => {
  try {
    const { data: user } = await adminSupabase
      .from('users')
      .select('id, full_name, country, region, plan, reputation_score, current_streak, best_streak, journeys_completed, created_at, avatar_url, is_banned, is_admin')
      .eq('id', req.params.id)
      .single()
    if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } })

    const { data: journeys } = await adminSupabase
      .from('journeys')
      .select('id, title, category, status, current_participants, stake_amount, start_date, end_date')
      .eq('creator_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(20)

    const { data: stakes } = await adminSupabase
      .from('stakes')
      .select('status, amount')
      .eq('user_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(1)

    res.json({ success: true, data: { ...user, journeys: journeys || [], latestStake: stakes?.[0] || null } })
  } catch (err) { next(err) }
})

// POST /admin/users/:id/ban
router.post('/users/:id/ban', async (req, res, next) => {
  try {
    await adminSupabase.from('users').update({ is_banned: true }).eq('id', req.params.id)
    res.json({ success: true })
  } catch (err) { next(err) }
})

// POST /admin/users/:id/unban
router.post('/users/:id/unban', async (req, res, next) => {
  try {
    await adminSupabase.from('users').update({ is_banned: false }).eq('id', req.params.id)
    res.json({ success: true })
  } catch (err) { next(err) }
})

// GET /admin/flagged-users — users who are banned OR have >= 3 total flags received
router.get('/flagged-users', async (req, res, next) => {
  try {
    const { limit = 100 } = req.query
    const { data } = await adminSupabase
      .from('users')
      .select('id, full_name, country, region, current_streak, reputation_score, total_flags_received, journeys_completed, is_banned, created_at')
      .or('is_banned.eq.true,total_flags_received.gte.3')
      .order('total_flags_received', { ascending: false })
      .limit(Number(limit))

    const userIds = (data || []).map(u => u.id)
    let stakeMap = {}
    if (userIds.length > 0) {
      const { data: stakes } = await adminSupabase
        .from('stakes')
        .select('user_id, status')
        .in('user_id', userIds)
        .in('status', ['forfeited', 'held'])
        .order('created_at', { ascending: false })
      for (const s of (stakes || [])) {
        if (!stakeMap[s.user_id]) stakeMap[s.user_id] = s.status
      }
    }

    const enriched = (data || []).map(u => ({ ...u, stake_status: stakeMap[u.id] || null }))
    res.json({ success: true, data: enriched })
  } catch (err) { next(err) }
})

// GET /admin/flagged-checkins — checkins with flag_count >= 2
router.get('/flagged-checkins', async (req, res, next) => {
  try {
    const { limit = 50, offset = 0 } = req.query
    const { data } = await adminSupabase
      .from('checkins')
      .select('id, checkin_date, note, proof_url, flag_count, admin_flagged, status, created_at, user:users(id, full_name), journey:journeys(id, title)')
      .gte('flag_count', 2)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)
    res.json({ success: true, data: data || [] })
  } catch (err) { next(err) }
})

// PATCH /admin/flagged-checkins/:id — approve or reject
router.patch('/flagged-checkins/:id', async (req, res, next) => {
  try {
    const { action } = req.body // 'approve' | 'reject'
    const updates = action === 'approve'
      ? { flag_count: 0, admin_flagged: false, status: 'approved' }
      : { admin_flagged: true, status: 'rejected' }
    await adminSupabase.from('checkins').update(updates).eq('id', req.params.id)
    res.json({ success: true })
  } catch (err) { next(err) }
})

// GET /admin/disputes — all disputes
router.get('/disputes', async (req, res, next) => {
  try {
    const { limit = 50, offset = 0 } = req.query
    const { data } = await adminSupabase
      .from('disputes')
      .select('id, type, description, status, created_at, reporter:users!reporter_id(id, full_name), journey:journeys(id, title)')
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)
    res.json({ success: true, data: data || [] })
  } catch (err) { next(err) }
})

// PATCH /admin/disputes/:id — update status
router.patch('/disputes/:id', async (req, res, next) => {
  try {
    const { status } = req.body
    await adminSupabase.from('disputes').update({ status }).eq('id', req.params.id)
    res.json({ success: true })
  } catch (err) { next(err) }
})

// GET /admin/categories — category summary from journeys
router.get('/categories', async (req, res, next) => {
  try {
    const CATS = [
      { name: 'Learning', color: '#6366f1' },
      { name: 'Fitness',  color: '#3ECFAA' },
      { name: 'Habit',    color: '#E8A838' },
      { name: 'Career',   color: '#47bfff' },
      { name: 'Faith',    color: '#a78bfa' },
      { name: 'Finance',  color: '#f87171' },
    ]
    const { data: journeys } = await adminSupabase
      .from('journeys')
      .select('category, status')
    const counts = {}
    for (const j of (journeys || [])) {
      if (!counts[j.category]) counts[j.category] = { total: 0, active: 0 }
      counts[j.category].total++
      if (j.status === 'active') counts[j.category].active++
    }
    const result = CATS.map(c => ({
      ...c,
      id: c.name.toLowerCase(),
      active_journeys: counts[c.name]?.active || 0,
      total_journeys: counts[c.name]?.total || 0,
      disabled: false,
    }))
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

// GET /admin/config — platform config
router.get('/config', async (req, res, next) => {
  try {
    const defaults = [
      { key: 'max_stake_ngn',            value: '10000', description: 'Maximum stake amount in Naira' },
      { key: 'min_stake_ngn',            value: '100',   description: 'Minimum stake amount in Naira' },
      { key: 'max_journey_days',         value: '90',    description: 'Max journey duration (days)' },
      { key: 'auto_abandon_missed_days', value: '3',     description: 'Consecutive missed days before auto-removal' },
      { key: 'relaxed_mode_max_misses',  value: '1',     description: 'Max missed days/week in relaxed mode' },
    ]
    const { data: rows } = await adminSupabase.from('platform_settings').select('key, value')
    const stored = {}
    for (const r of (rows || [])) stored[r.key] = r.value
    const config = defaults.map(d => ({ ...d, value: stored[d.key] ?? d.value }))
    res.json({ success: true, data: config })
  } catch (err) {
    // table may not exist yet — return defaults
    const defaults = [
      { key: 'max_stake_ngn',            value: '10000', description: 'Maximum stake amount in Naira' },
      { key: 'min_stake_ngn',            value: '100',   description: 'Minimum stake amount in Naira' },
      { key: 'max_journey_days',         value: '90',    description: 'Max journey duration (days)' },
      { key: 'auto_abandon_missed_days', value: '3',     description: 'Consecutive missed days before auto-removal' },
      { key: 'relaxed_mode_max_misses',  value: '1',     description: 'Max missed days/week in relaxed mode' },
    ]
    res.json({ success: true, data: defaults })
  }
})

// PUT /admin/config — save platform config
router.put('/config', async (req, res, next) => {
  try {
    const { config } = req.body // [{ key, value }]
    for (const item of (config || [])) {
      await adminSupabase.from('platform_settings')
        .upsert({ key: item.key, value: String(item.value) }, { onConflict: 'key' })
    }
    res.json({ success: true })
  } catch (err) { next(err) }
})

// GET /admin/accounts — all admin users
router.get('/accounts', async (req, res, next) => {
  try {
    const { data } = await adminSupabase
      .from('users')
      .select('id, full_name, created_at, is_admin')
      .eq('is_admin', true)
      .order('created_at', { ascending: false })
    res.json({ success: true, data: data || [] })
  } catch (err) { next(err) }
})

// POST /admin/broadcast — send a notification + push to all users
router.post('/broadcast', async (req, res, next) => {
  try {
    const { title, body, type = 'announcement', data = {} } = req.body
    if (!title || !body) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'title and body are required.' } })
    }

    const { data: users } = await adminSupabase
      .from('users')
      .select('id, notification_token, notification_enabled')

    if (!users || users.length === 0) {
      return res.json({ success: true, sent: 0, pushed: 0 })
    }

    // Bulk-insert notifications for all users
    const notifications = users.map(u => ({
      user_id: u.id,
      type,
      title,
      body,
      data,
      read: false,
    }))
    await adminSupabase.from('notifications').insert(notifications)

    // Send push only to users with a valid token and notifications enabled
    const { Expo } = require('expo-server-sdk')
    const expo = new Expo()
    const messages = users
      .filter(u => u.notification_enabled && u.notification_token && Expo.isExpoPushToken(u.notification_token))
      .map(u => ({ to: u.notification_token, sound: 'default', title, body, data }))

    let pushed = 0
    if (messages.length > 0) {
      const chunks = expo.chunkPushNotifications(messages)
      for (const chunk of chunks) {
        try { await expo.sendPushNotificationsAsync(chunk); pushed += chunk.length } catch (_) {}
      }
    }

    // Log a single record so Send History can show it
    adminSupabase.from('admin_notifications').insert({
      type: 'announcement',
      title,
      body,
      data: { sent: users.length, pushed },
      resolved: true,
    }).then(() => {}).catch(() => {})

    res.json({ success: true, sent: users.length, pushed })
  } catch (err) { next(err) }
})

module.exports = router
