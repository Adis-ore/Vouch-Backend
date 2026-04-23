const router = require('express').Router()

router.use('/auth', require('./auth'))
router.use('/drafts', require('./drafts'))
router.use('/journeys', require('./journeys'))
router.use('/checkins', require('./checkins'))
router.use('/milestones', require('./milestones'))
router.use('/messages', require('./messages'))
router.use('/payments', require('./payments'))
router.use('/notifications', require('./notifications'))
router.use('/users', require('./users'))
router.use('/search', require('./search'))
router.use('/disputes', require('./disputes'))
router.use('/admin', require('./admin'))

if (process.env.NODE_ENV !== 'production') {
  router.use('/test', require('./test'))
}

module.exports = router
