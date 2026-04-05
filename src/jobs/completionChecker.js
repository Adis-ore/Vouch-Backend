const cron = require('node-cron')
const { adminSupabase } = require('../lib/supabase')
const { sendPush } = require('../lib/push')
const { initiateRefund } = require('../lib/paystack')

function registerCompletionChecker() {
  // Runs daily at 00:00 AM UTC
  cron.schedule('0 0 * * *', async () => {
    console.log('[CRON] Running completion checker')

    const today = new Date().toISOString().split('T')[0]

    // Find journeys whose end_date was yesterday or earlier and are still active
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
      // Mark journey as completed
      await adminSupabase
        .from('journeys')
        .update({ status: 'completed' })
        .eq('id', journey.id)

      // Get all remaining members
      const { data: members } = await adminSupabase
        .from('journey_members')
        .select('user_id, stake_status')
        .eq('journey_id', journey.id)

      if (!members) continue

      for (const member of members) {
        // Increment journeys_completed on user
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
              reputation_score: (userData.reputation_score || 100) + 10
            })
            .eq('id', member.user_id)
        }

        // Return held stake
        if (member.stake_status === 'held') {
          const { data: stake } = await adminSupabase
            .from('stakes')
            .select('*')
            .eq('journey_id', journey.id)
            .eq('user_id', member.user_id)
            .eq('status', 'held')
            .single()

          if (stake?.paystack_transaction_id) {
            try {
              await initiateRefund({
                transaction: stake.paystack_transaction_id,
                amount: stake.amount * 100
              })
            } catch (err) {
              console.error(`[CRON] Refund failed for stake ${stake.id}:`, err.message)
            }
          }

          await adminSupabase
            .from('stakes')
            .update({ status: 'returned', returned_at: new Date().toISOString() })
            .eq('id', stake.id)

          await adminSupabase
            .from('journey_members')
            .update({ stake_status: 'returned' })
            .eq('journey_id', journey.id)
            .eq('user_id', member.user_id)
        }

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
