const cron = require('node-cron')
const { adminSupabase } = require('../lib/supabase')
const { completeJourneyForUser } = require('../lib/completion')

function registerCompletionChecker() {
  // Runs daily at 00:05 AM UTC (gives midnight cron a moment to settle)
  cron.schedule('5 0 * * *', async () => {
    console.log('[CRON] Running completion checker')

    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split('T')[0]

    // Find journeys whose end_date has passed and still have active members
    const { data: dueJourneys } = await adminSupabase
      .from('journeys')
      .select('id, title, duration_days')
      .eq('status', 'active')
      .lte('end_date', yesterdayStr)

    if (!dueJourneys?.length) return

    for (const journey of dueJourneys) {
      // Fetch all still-active members for this journey
      const { data: activeMembers } = await adminSupabase
        .from('journey_members')
        .select('user_id')
        .eq('journey_id', journey.id)
        .eq('status', 'active')

      if (!activeMembers?.length) {
        // All members already completed individually — just mark journey done
        await adminSupabase.from('journeys').update({ status: 'completed' }).eq('id', journey.id)
        continue
      }

      // completeJourneyForUser handles refund, badges, history, notification, and marks
      // journey.status = 'completed' when the last active member is processed.
      for (const m of activeMembers) {
        await completeJourneyForUser(journey.id, m.user_id)
      }
    }
  })
}

module.exports = { registerCompletionChecker }
