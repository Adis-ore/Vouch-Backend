const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')

// GET /notifications — get current user's notifications
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { limit = 30, offset = 0 } = req.query
    const { data, error } = await adminSupabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (error) throw error

    const unreadCount = data.filter(n => !n.read).length
    res.json({ success: true, notifications: data, unread_count: unreadCount })
  } catch (err) { next(err) }
})

// PATCH /notifications/:id/read — mark a single notification as read
router.patch('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const { error } = await adminSupabase
      .from('notifications')
      .update({ read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)

    if (error) throw error
    res.json({ success: true })
  } catch (err) { next(err) }
})

// PATCH /notifications/read-all — mark all notifications as read
router.patch('/read-all', requireAuth, async (req, res, next) => {
  try {
    const { error } = await adminSupabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', req.user.id)
      .eq('read', false)

    if (error) throw error
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
