const cron = require('node-cron')
const { adminSupabase } = require('../lib/supabase')
const { sendPush } = require('../lib/push')

function registerMilestoneChecker() {
  // Runs every Sunday at 11:00 PM UTC
  cron.schedule('0 23 * * 0', async () => {
    console.log('[CRON] Running milestone checker')

    const { data: activeJourneys } = await adminSupabase
      .from('journeys')
      .select('id, title, start_date')
      .eq('status', 'active')

    if (!activeJourneys?.length) return

    for (const journey of activeJourneys) {
      const start = new Date(journey.start_date)
      const now = new Date()
      const weeksElapsed = Math.floor((now - start) / (7 * 24 * 60 * 60 * 1000)) + 1

      // Find the milestone for this week that isn't unlocked yet
      const { data: milestone } = await adminSupabase
        .from('milestones')
        .select('id, week_number, title')
        .eq('journey_id', journey.id)
        .eq('week_number', weeksElapsed)
        .eq('is_unlocked', false)
        .single()

      if (!milestone) continue

      // Unlock the milestone
      await adminSupabase
        .from('milestones')
        .update({ is_unlocked: true, unlocked_at: new Date().toISOString() })
        .eq('id', milestone.id)

      // Post system message
      await adminSupabase.from('messages').insert({
        journey_id: journey.id,
        sender_id: null,
        content: `Week ${milestone.week_number} milestone unlocked: "${milestone.title}". Time to reflect!`,
        type: 'milestone_unlock'
      })

      // Notify all members
      const { data: members } = await adminSupabase
        .from('journey_members')
        .select('user_id')
        .eq('journey_id', journey.id)

      if (!members) continue

      for (const member of members) {
        await sendPush(
          member.user_id,
          'Milestone unlocked',
          `Week ${milestone.week_number} of "${journey.title}" — time to reflect.`,
          { journey_id: journey.id, milestone_id: milestone.id, type: 'milestone_unlock' }
        )
      }
    }
  })
}

module.exports = { registerMilestoneChecker }
