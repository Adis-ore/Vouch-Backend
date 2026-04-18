// Join window: first 10% of a journey's duration after it starts.
// A journey with status 'open' (not yet started) is always joinable.

function getJoinDeadline(startDate, durationDays) {
  const start = new Date(startDate)
  const windowMs = durationDays * 0.10 * 24 * 60 * 60 * 1000
  return new Date(start.getTime() + windowMs)
}

function isJoinWindowOpen(journey) {
  if (journey.status === 'open') return true   // hasn't started yet
  if (journey.status !== 'active') return false // completed/abandoned
  const deadline = getJoinDeadline(journey.start_date, journey.duration_days)
  return new Date() <= deadline
}

function getJoinWindowLabel(journey) {
  if (journey.status === 'open') return { text: 'Not started yet · Join now', state: 'waiting' }
  if (journey.status !== 'active') return null

  const deadline = getJoinDeadline(journey.start_date, journey.duration_days)
  const msLeft = deadline - new Date()
  if (msLeft <= 0) return { text: 'In progress · No longer joinable', state: 'closed' }

  const hoursLeft = Math.floor(msLeft / 3600000)
  const daysLeft = Math.floor(hoursLeft / 24)
  const timeStr = daysLeft > 0 ? `${daysLeft}d ${hoursLeft % 24}h left` : `${hoursLeft}h left`
  return { text: `Join window: ${timeStr}`, state: 'open' }
}

module.exports = { getJoinDeadline, isJoinWindowOpen, getJoinWindowLabel }
