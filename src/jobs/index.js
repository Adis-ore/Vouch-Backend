const { registerStreakChecker } = require('./streakChecker')
const { registerMilestoneChecker } = require('./milestoneChecker')
const { registerCompletionChecker } = require('./completionChecker')
const { registerStreakNotifications } = require('./streakNotifications')

function scheduleJobs() {
  registerStreakChecker()
  registerStreakNotifications()
  registerMilestoneChecker()
  registerCompletionChecker()
  console.log('[CRON] All jobs scheduled')
}

module.exports = { scheduleJobs }
