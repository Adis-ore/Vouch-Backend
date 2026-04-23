const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')
const { sendPush } = require('../lib/push')

// POST /test/notification — insert a notification directly (dev only)
router.post('/notification', requireAuth, async (req, res, next) => {
  try {
    const { type, title, body, data } = req.body
    const { data: notif, error } = await adminSupabase
      .from('notifications')
      .insert({
        user_id: req.user.id,
        type: type || 'test',
        title: title || 'Test notification',
        body: body || 'This is a test notification',
        data: data || {},
        read: false,
      })
      .select()
      .single()
    if (error) throw error
    // Also send push if requested
    if (req.body.push) {
      await sendPush(req.user.id, notif.title, notif.body, notif.data).catch(() => {})
    }
    res.json({ success: true, notification: notif })
  } catch (err) { next(err) }
})

module.exports = router
