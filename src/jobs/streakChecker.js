const cron = require('node-cron')
const { adminSupabase } = require('../lib/supabase')
const { recalculateStreak } = require('../lib/streak')
const { sendPush } = require('../lib/push')
const { getTimezoneForCountry, getLocalDate, getLocalHour } = require('../lib/timezones')
const { writeHistory } = require('../lib/historyHelper')

// Runs every hour — processes users whose local time is 00:00–01:00 (midnight just rolled over)
function registerStreakChecker() {
  cron.schedule('5 * * * *', async () => {
    console.log('[CRON] Streak checker tick')
    try {
      await runStreakReset()
    } catch (err) {
      console.error('[CRON] Streak checker error:', err.message)
    }
  })
}

async function runStreakReset() {
  const { data: users } = await adminSupabase
    .from('users')
    .select('id, country, timezone, current_streak, global_streak')
    .not('id', 'is', null)

  if (!users?.length) return

  for (const user of users) {
    const timezone = user.timezone || getTimezoneForCountry(user.country)
    if (getLocalHour(timezone) !== 0) continue

    await processUserAtMidnight(user, timezone)
  }
}

async function processUserAtMidnight(user, timezone) {
  const localYesterday = getLocalDate(timezone, -1)

  // ─── Per-journey streak reset + auto-abandon ─────────────────────────────
  const { data: memberships } = await adminSupabase
    .from('journey_members')
    .select('journey_id, current_streak, consecutive_missed, last_checkin_date, stake_status, journeys(id, title, status)')
    .eq('user_id', user.id)

  const activeJourneyIds = []

  for (const member of (memberships || [])) {
    const journey = member.journeys
    if (!journey || journey.status !== 'active') continue
    activeJourneyIds.push(member.journey_id)

    const checkedYesterday = member.last_checkin_date === localYesterday
    if (checkedYesterday) continue

    const newMissed = (member.consecutive_missed || 0) + 1
    await adminSupabase
      .from('journey_members')
      .update({ current_streak: 0, consecutive_missed: newMissed })
      .eq('journey_id', member.journey_id)
      .eq('user_id', user.id)

    // Auto-abandon after 3 consecutive misses
    if (newMissed >= 3) {
      await adminSupabase
        .from('stakes')
        .update({ status: 'forfeited', forfeited_at: new Date().toISOString() })
        .eq('journey_id', member.journey_id)
        .eq('user_id', user.id)
        .eq('status', 'held')

      await adminSupabase
        .from('journey_members')
        .update({ stake_status: 'forfeited' })
        .eq('journey_id', member.journey_id)
        .eq('user_id', user.id)

      await writeHistory(user.id, journey, { ...member, stake_status: 'forfeited' }, 'auto_removed')

      await adminSupabase.from('journey_members').delete()
        .eq('journey_id', member.journey_id).eq('user_id', user.id)

      const { data: j } = await adminSupabase
        .from('journeys').select('current_participants').eq('id', member.journey_id).single()
      if (j) {
        await adminSupabase
          .from('journeys')
          .update({ current_participants: Math.max(0, j.current_participants - 1) })
          .eq('id', member.journey_id)
      }

      await sendPush(user.id, 'Removed from journey',
        'You missed 3 days in a row and have been removed. Your deposit was forfeited.',
        { journey_id: member.journey_id })
    }
  }

  // ─── Recalculate global streak (uses strict/relaxed mode) ─────────────────
  if (activeJourneyIds.length === 0) return

  const previousStreak = user.current_streak || user.global_streak || 0
  const newStreak = await recalculateStreak(user.id, timezone)

  // Notify on streak broken (strict: any miss; relaxed: handled inside recalculate)
  if (newStreak === 0 && previousStreak > 0) {
    await sendPush(user.id, 'Streak reset',
      `Your ${previousStreak}-day streak just reset. Start fresh today.`,
      { type: 'streak_broken' })

    await adminSupabase.from('notifications').insert({
      user_id: user.id,
      type: 'streak_broken',
      title: 'Streak reset',
      body: `Your ${previousStreak}-day streak just reset. Start fresh today.`,
      data: { route: 'home' },
      read: false,
    }).then(() => {}).catch(() => {})
  }
}

module.exports = { registerStreakChecker }
