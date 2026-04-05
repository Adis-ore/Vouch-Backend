const { registerStreakChecker } = require('./streakChecker')
const { registerCheckinReminder } = require('./checkInReminder')
const { registerMilestoneChecker } = require('./milestoneChecker')
const { registerCompletionChecker } = require('./completionChecker')

function scheduleJobs() {
  registerStreakChecker()
  registerCheckinReminder()
  registerMilestoneChecker()
  registerCompletionChecker()
  console.log('[CRON] All jobs scheduled')
}

module.exports = { scheduleJobs }
