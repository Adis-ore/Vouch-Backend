const { adminSupabase } = require('./supabase')
const { sendPush } = require('./push')

async function updateStreak(userId, journeyId, today) {
  const { data: member } = await adminSupabase
    .from('journey_members')
    .select('current_streak, longest_streak, last_checkin_date')
    .eq('journey_id', journeyId)
    .eq('user_id', userId)
    .single()

  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = yesterday.toISOString().split('T')[0]

  const checkedInYesterday = member.last_checkin_date === yesterdayStr
  const newStreak = checkedInYesterday ? member.current_streak + 1 : 1
  const longestStreak = Math.max(newStreak, member.longest_streak || 0)

  await adminSupabase
    .from('journey_members')
    .update({
      current_streak: newStreak,
      longest_streak: longestStreak,
      last_checkin_date: today,
      consecutive_missed: 0
    })
    .eq('journey_id', journeyId)
    .eq('user_id', userId)

  // Update global user stats
  const { data: userData } = await adminSupabase
    .from('users')
    .select('streak_total, longest_streak')
    .eq('id', userId)
    .single()

  await adminSupabase
    .from('users')
    .update({
      streak_total: (userData.streak_total || 0) + 1,
      longest_streak: Math.max(longestStreak, userData.longest_streak || 0)
    })
    .eq('id', userId)

  return newStreak
}

async function checkAndAwardBadges(userId, currentStreak) {
  const streakMilestones = [
    { streak: 3,   key: 'streak_3',   name: 'Getting Started',  body: 'You hit a 3-day streak!' },
    { streak: 7,   key: 'streak_7',   name: 'On Fire',          body: 'You hit a 7-day streak!' },
    { streak: 14,  key: 'streak_14',  name: 'Two Weeks Strong', body: '14 days straight. Serious.' },
    { streak: 30,  key: 'streak_30',  name: 'Unstoppable',      body: '30-day streak achieved!' },
    { streak: 60,  key: 'streak_60',  name: 'Elite',            body: '60 consecutive days. Legendary.' },
    { streak: 100, key: 'streak_100', name: 'Centurion',        body: '100 days. You are built different.' }
  ]

  for (const milestone of streakMilestones) {
    if (currentStreak >= milestone.streak) {
      const { data: existing } = await adminSupabase
        .from('badges')
        .select('id')
        .eq('user_id', userId)
        .eq('badge_key', milestone.key)
        .single()

      if (!existing) {
        await adminSupabase.from('badges').insert({ user_id: userId, badge_key: milestone.key })
        await sendPush(userId, `Badge earned: ${milestone.name}`, milestone.body, { badge_key: milestone.key })
      }
    }
  }
}

module.exports = { updateStreak, checkAndAwardBadges }
