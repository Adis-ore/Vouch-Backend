const router = require('express').Router()

router.use('/auth', require('./auth'))
router.use('/journeys', require('./journeys'))
router.use('/checkins', require('./checkins'))
router.use('/milestones', require('./milestones'))
router.use('/messages', require('./messages'))
router.use('/payments', require('./payments'))
router.use('/notifications', require('./notifications'))
router.use('/users', require('./users'))
router.use('/search', require('./search'))
router.use('/disputes', require('./disputes'))

module.exports = router
