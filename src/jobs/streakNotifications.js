const cron = require('node-cron')
const { adminSupabase } = require('../lib/supabase')
const { sendPush } = require('../lib/push')
const { getTimezoneForCountry, getLocalHour, getLocalDate } = require('../lib/timezones')

function registerStreakNotifications() {
  // Every hour — send morning reminders (8 AM local), evening warnings (9 PM local)
  cron.schedule('0 * * * *', async () => {
    try {
      await sendHourlyReminders()
    } catch (err) {
      console.error('[CRON] Streak notifications error:', err.message)
    }
  })
}

async function sendHourlyReminders() {
  const { data: users } = await adminSupabase
    .from('users')
    .select('id, country, timezone, current_streak, global_streak, notification_enabled')
    .eq('notification_enabled', true)

  if (!users?.length) return

  for (const user of users) {
    const timezone = user.timezone || getTimezoneForCountry(user.country)
    const localHour = getLocalHour(timezone)

    if (localHour !== 8 && localHour !== 21) continue

    await sendReminderIfIncomplete(user, timezone, localHour)
  }
}

async function sendReminderIfIncomplete(user, timezone, hour) {
  const today = getLocalDate(timezone)

  const { data: memberships } = await adminSupabase
    .from('journey_members')
    .select('journey_id, journeys(status)')
    .eq('user_id', user.id)

  const activeJourneyIds = (memberships || [])
    .filter(m => m.journeys?.status === 'active')
    .map(m => m.journey_id)

  if (activeJourneyIds.length === 0) return

  const { data: todayCheckins } = await adminSupabase
    .from('checkins')
    .select('journey_id')
    .eq('user_id', user.id)
    .eq('checkin_date', today)
    .in('journey_id', activeJourneyIds)

  const checkedCount = (todayCheckins || []).length
  const uncheckedCount = activeJourneyIds.length - checkedCount

  if (uncheckedCount === 0) return  // already done — no notification needed

  const streak = user.current_streak || user.global_streak || 0
  const journeyWord = uncheckedCount === 1 ? 'journey' : 'journeys'

  let title, body

  if (hour === 8) {
    title = 'Check-in reminder'
    body = streak > 0
      ? `${streak}-day streak on the line — check in on ${uncheckedCount} more ${journeyWord} today`
      : `Check in on ${uncheckedCount} ${journeyWord} to start your streak`
  } else {
    // 9 PM — urgent
    title = '3 hours left'
    body = streak > 0
      ? `Your ${streak}-day streak resets at midnight — ${uncheckedCount} ${journeyWord} still to go`
      : `Don't forget — ${uncheckedCount} ${journeyWord} left to check in on today`
  }

  await sendPush(user.id, title, body, { type: 'checkin_reminder', route: 'home' })

  await adminSupabase.from('notifications').insert({
    user_id: user.id,
    type: 'checkin_reminder',
    title,
    body,
    data: { route: 'home' },
    read: false,
  }).then(() => {}).catch(() => {})
}

module.exports = { registerStreakNotifications }
