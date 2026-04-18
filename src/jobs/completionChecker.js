const cron = require('node-cron')
const { adminSupabase } = require('../lib/supabase')
const { sendPush } = require('../lib/push')
const { processStakeRefund } = require('../lib/refund')
const { writeHistory } = require('../lib/historyHelper')

function registerCompletionChecker() {
  // Runs daily at 00:00 AM UTC
  cron.schedule('0 0 * * *', async () => {
    console.log('[CRON] Running completion checker')

    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split('T')[0]

    const { data: dueJourneys } = await adminSupabase
      .from('journeys')
      .select('id, title, duration_days')
      .eq('status', 'active')
      .lte('end_date', yesterdayStr)

    if (!dueJourneys?.length) return

    for (const journey of dueJourneys) {
      await adminSupabase
        .from('journeys')
        .update({ status: 'completed' })
        .eq('id', journey.id)

      const { data: members } = await adminSupabase
        .from('journey_members')
        .select('user_id, stake_status, total_checkins')
        .eq('journey_id', journey.id)

      if (!members) continue

      for (const member of members) {
        const { data: userData } = await adminSupabase
          .from('users')
          .select('journeys_completed, reputation_score')
          .eq('id', member.user_id)
          .single()

        if (userData) {
          await adminSupabase
            .from('users')
            .update({
              journeys_completed: (userData.journeys_completed || 0) + 1,
              reputation_score: Math.min(100, (userData.reputation_score || 0) + 10),
            })
            .eq('id', member.user_id)
        }

        if (member.stake_status === 'held') {
          const completionPercent = journey.duration_days > 0
            ? Math.round(((member.total_checkins || 0) / journey.duration_days) * 100)
            : 0
          await processStakeRefund({
            journeyId: journey.id,
            userId: member.user_id,
            completionPercent,
          })
        }

        // Determine final stake status for history
        const { data: updatedStake } = await adminSupabase
          .from('stakes')
          .select('status')
          .eq('journey_id', journey.id)
          .eq('user_id', member.user_id)
          .single()

        const finalStakeStatus = updatedStake?.status ?? member.stake_status
        await writeHistory(member.user_id, journey, { ...member, stake_status: finalStakeStatus }, 'completed')

        await sendPush(
          member.user_id,
          'Journey completed',
          `You completed "${journey.title}". Great work.`,
          { journey_id: journey.id, type: 'journey_completed' }
        )
      }
    }
  })
}

module.exports = { registerCompletionChecker }
