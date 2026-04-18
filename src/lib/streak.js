const { adminSupabase } = require('./supabase')
const { sendPush } = require('./push')
const { getLocalDate } = require('./timezones')
const { checkAndAwardBadges } = require('./badges')

/**
 * recalculateStreak — walks backwards through check-in history and returns
 * the correct streak for the user based on their streak_mode.
 *
 * Strict:  any day where not ALL active journeys were checked in = streak broken
 * Relaxed: up to 1 missed day per 7-day rolling window is forgiven
 *
 * Returns the new streak value and writes current_streak + longest_streak to users.
 */
async function recalculateStreak(userId, timezone = 'Africa/Lagos') {
  const since = new Date()
  since.setDate(since.getDate() - 31)
  const sinceStr = since.toISOString().split('T')[0]

  // All memberships — active ones + recently completed/abandoned (within window)
  const { data: memberships } = await adminSupabase
    .from('journey_members')
    .select('journey_id, joined_at, completed_at, abandoned_at, status')
    .eq('user_id', userId)

  const relevant = (memberships || []).filter(m => {
    if (m.status === 'active') return true
    const endedAt = m.completed_at || m.abandoned_at
    return endedAt && new Date(endedAt) >= since
  })

  if (relevant.length === 0) {
    await adminSupabase.from('users').update({
      current_streak: 0, global_streak: 0, global_streak_date: getLocalDate(timezone),
    }).eq('id', userId)
    return 0
  }

  const allJourneyIds = [...new Set(relevant.map(m => m.journey_id))]

  const { data: userProfile } = await adminSupabase
    .from('users').select('streak_mode, longest_streak').eq('id', userId).single()
  const streakMode = userProfile?.streak_mode || 'relaxed'

  const { data: checkins } = await adminSupabase
    .from('checkins')
    .select('journey_id, checkin_date')
    .eq('user_id', userId)
    .in('journey_id', allJourneyIds)
    .gte('checkin_date', sinceStr)

  const checkinsByDate = {}
  for (const c of (checkins || [])) {
    if (!checkinsByDate[c.checkin_date]) checkinsByDate[c.checkin_date] = new Set()
    checkinsByDate[c.checkin_date].add(c.journey_id)
  }

  // Which journeys was the user required to check into on a given date?
  function getRequiredOnDate(dateStr) {
    const dayStart = new Date(dateStr + 'T00:00:00Z')
    const dayEnd   = new Date(dateStr + 'T23:59:59Z')
    return relevant.filter(m => {
      if (m.joined_at && new Date(m.joined_at) > dayEnd) return false
      if (m.completed_at && new Date(m.completed_at) < dayStart) return false
      if (m.abandoned_at && new Date(m.abandoned_at) < dayStart) return false
      return true
    }).map(m => m.journey_id)
  }

  const isCompleteDay = (dateStr) => {
    const required = getRequiredOnDate(dateStr)
    if (required.length === 0) return false
    const set = checkinsByDate[dateStr]
    if (!set) return false
    return required.every(id => set.has(id))
  }

  const today = getLocalDate(timezone)
  let currentStreak = 0
  let missedInWindow = 0
  let i = 1

  while (i <= 30) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().split('T')[0]
    const complete = isCompleteDay(dateStr)

    if (streakMode === 'strict') {
      if (!complete) break
      currentStreak++
    } else {
      if (!complete) {
        missedInWindow++
        if (missedInWindow > 1) break
      } else {
        currentStreak++
      }
      if (i % 7 === 0) missedInWindow = 0
    }
    i++
  }

  if (isCompleteDay(today)) currentStreak++

  const longestStreak = Math.max(currentStreak, userProfile?.longest_streak || 0)

  await adminSupabase.from('users').update({
    current_streak: currentStreak,
    global_streak: currentStreak,
    global_streak_date: today,
    longest_streak: longestStreak,
  }).eq('id', userId)

  return currentStreak
}

/**
 * updateStreak — called after each check-in submission.
 * Updates per-journey streak, increments streak_total, then recalculates global streak.
 */
async function updateStreak(userId, journeyId, today, timezone) {
  const tz = timezone || 'Africa/Lagos'
  const localToday = today || getLocalDate(tz)
  const localYesterday = getLocalDate(tz, -1)

  // Per-journey streak
  const { data: member } = await adminSupabase
    .from('journey_members')
    .select('current_streak, longest_streak, last_checkin_date')
    .eq('journey_id', journeyId)
    .eq('user_id', userId)
    .single()

  if (member) {
    const checkedYesterday = member.last_checkin_date === localYesterday
    const newJourneyStreak = checkedYesterday ? (member.current_streak || 0) + 1 : 1
    const newJourneyLongest = Math.max(newJourneyStreak, member.longest_streak || 0)

    await adminSupabase
      .from('journey_members')
      .update({
        current_streak: newJourneyStreak,
        longest_streak: newJourneyLongest,
        last_checkin_date: localToday,
        consecutive_missed: 0,
      })
      .eq('journey_id', journeyId)
      .eq('user_id', userId)
  }

  // Increment total check-in count (every submission, regardless of completeness)
  const { data: userData } = await adminSupabase
    .from('users')
    .select('streak_total')
    .eq('id', userId)
    .single()

  await adminSupabase
    .from('users')
    .update({ streak_total: (userData?.streak_total || 0) + 1 })
    .eq('id', userId)

  // Recalculate global streak
  const newStreak = await recalculateStreak(userId, tz)
  return newStreak
}

module.exports = { updateStreak, recalculateStreak, checkAndAwardBadges }
