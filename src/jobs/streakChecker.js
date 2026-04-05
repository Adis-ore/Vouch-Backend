const cron = require('node-cron')
const { adminSupabase } = require('../lib/supabase')
const { sendPush } = require('../lib/push')

function registerStreakChecker() {
  // Runs daily at 00:05 AM UTC
  cron.schedule('5 0 * * *', async () => {
    console.log('[CRON] Running streak checker')

    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split('T')[0]

    const { data: activeJourneys } = await adminSupabase
      .from('journeys')
      .select('id')
      .eq('status', 'active')

    if (!activeJourneys?.length) return

    for (const journey of activeJourneys) {
      const { data: members } = await adminSupabase
        .from('journey_members')
        .select('user_id, current_streak, consecutive_missed, last_checkin_date, stake_status, user:users(notification_token)')
        .eq('journey_id', journey.id)

      if (!members) continue

      for (const member of members) {
        const checkedInYesterday = member.last_checkin_date === yesterdayStr
        if (checkedInYesterday) continue

        const newMissed = (member.consecutive_missed || 0) + 1

        await adminSupabase
          .from('journey_members')
          .update({ current_streak: 0, consecutive_missed: newMissed })
          .eq('journey_id', journey.id)
          .eq('user_id', member.user_id)

        await sendPush(
          member.user_id,
          'Streak broken',
          'You missed yesterday. Start fresh today — your partner needs you.',
          { journey_id: journey.id }
        )

        // Auto-abandon after 3 consecutive misses
        if (newMissed >= 3) {
          // Forfeit held stake
          await adminSupabase
            .from('stakes')
            .update({ status: 'forfeited', forfeited_at: new Date().toISOString() })
            .eq('journey_id', journey.id)
            .eq('user_id', member.user_id)
            .eq('status', 'held')

          await adminSupabase
            .from('journey_members')
            .update({ stake_status: 'forfeited' })
            .eq('journey_id', journey.id)
            .eq('user_id', member.user_id)

          await sendPush(
            member.user_id,
            'Removed from journey',
            'You missed 3 days in a row. You have been removed and your deposit forfeited.',
            { journey_id: journey.id }
          )

          await adminSupabase
            .from('journey_members')
            .delete()
            .eq('journey_id', journey.id)
            .eq('user_id', member.user_id)

          // Decrement participant count
          const { data: j } = await adminSupabase
            .from('journeys').select('current_participants').eq('id', journey.id).single()
          if (j) {
            await adminSupabase
              .from('journeys')
              .update({ current_participants: Math.max(0, j.current_participants - 1) })
              .eq('id', journey.id)
          }
        }
      }
    }
  })
}

module.exports = { registerStreakChecker }
