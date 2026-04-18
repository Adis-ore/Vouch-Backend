const { adminSupabase } = require('./supabase')
const { sendPush } = require('./push')
const { getLocalDate } = require('./timezones')

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
  const { data: memberships } = await adminSupabase
    .from('journey_members')
    .select('journey_id, journeys(id, status)')
    .eq('user_id', userId)

  const activeJourneyIds = (memberships || [])
    .filter(m => m.journeys?.status === 'active')
    .map(m => m.journey_id)

  if (activeJourneyIds.length === 0) return 0

  const { data: userProfile } = await adminSupabase
    .from('users')
    .select('streak_mode, current_streak, longest_streak')
    .eq('id', userId)
    .single()

  const streakMode = userProfile?.streak_mode || 'relaxed'

  const since = new Date()
  since.setDate(since.getDate() - 30)
  const sinceStr = since.toISOString().split('T')[0]

  const { data: checkins } = await adminSupabase
    .from('checkins')
    .select('journey_id, checkin_date')
    .eq('user_id', userId)
    .in('journey_id', activeJourneyIds)
    .gte('checkin_date', sinceStr)

  const checkinsByDate = {}
  for (const c of (checkins || [])) {
    if (!checkinsByDate[c.checkin_date]) checkinsByDate[c.checkin_date] = new Set()
    checkinsByDate[c.checkin_date].add(c.journey_id)
  }

  const isCompleteDay = (dateStr) => {
    const set = checkinsByDate[dateStr]
    return !!set && activeJourneyIds.every(id => set.has(id))
  }

  const today = getLocalDate(timezone)
  let currentStreak = 0
  let missedInWindow = 0
  let i = 1  // start from yesterday

  while (i <= 30) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().split('T')[0]
    const complete = isCompleteDay(dateStr)

    if (streakMode === 'strict') {
      if (!complete) break
      currentStreak++
    } else {
      // Relaxed: 1 missed day per 7-day window forgiven
      if (!complete) {
        missedInWindow++
        if (missedInWindow > 1) break
        // 1 miss forgiven — don't increment streak but don't break either
      } else {
        currentStreak++
      }
      if (i % 7 === 0) missedInWindow = 0
    }

    i++
  }

  // If today is already a complete day, it counts NOW (optimistic advance)
  if (isCompleteDay(today)) currentStreak++

  const longestStreak = Math.max(currentStreak, userProfile?.longest_streak || 0)

  await adminSupabase.from('users').update({
    current_streak: currentStreak,
    global_streak: currentStreak,      // keep in sync for backward compat
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

async function checkAndAwardBadges(userId, currentStreak) {
  const milestones = [
    { streak: 3,   key: 'streak_3',   name: 'Getting Started',  body: 'You hit a 3-day streak!' },
    { streak: 7,   key: 'streak_7',   name: 'On Fire',          body: 'You hit a 7-day streak!' },
    { streak: 14,  key: 'streak_14',  name: 'Two Weeks Strong', body: '14 days straight. Serious.' },
    { streak: 30,  key: 'streak_30',  name: 'Unstoppable',      body: '30-day streak achieved!' },
    { streak: 60,  key: 'streak_60',  name: 'Elite',            body: '60 consecutive days. Legendary.' },
    { streak: 100, key: 'streak_100', name: 'Centurion',        body: '100 days. You are built different.' },
  ]

  for (const m of milestones) {
    if (currentStreak >= m.streak) {
      const { data: existing } = await adminSupabase
        .from('badges').select('id').eq('user_id', userId).eq('badge_key', m.key).single()
      if (!existing) {
        await adminSupabase.from('badges').insert({ user_id: userId, badge_key: m.key })
        await sendPush(userId, `Badge earned: ${m.name}`, m.body, { badge_key: m.key })
      }
    }
  }
}

module.exports = { updateStreak, recalculateStreak, checkAndAwardBadges }
