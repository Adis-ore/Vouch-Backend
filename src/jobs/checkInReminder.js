const cron = require('node-cron')
const { adminSupabase } = require('../lib/supabase')
const { sendPush } = require('../lib/push')

function registerCheckinReminder() {
  // Runs daily at 8:00 PM local UTC — remind users who haven't checked in
  cron.schedule('0 17 * * *', async () => {
    console.log('[CRON] Running check-in reminder')

    const today = new Date().toISOString().split('T')[0]

    const { data: activeJourneys } = await adminSupabase
      .from('journeys')
      .select('id, title')
      .eq('status', 'active')

    if (!activeJourneys?.length) return

    for (const journey of activeJourneys) {
      const { data: members } = await adminSupabase
        .from('journey_members')
        .select('user_id')
        .eq('journey_id', journey.id)

      if (!members) continue

      for (const member of members) {
        const { data: checkin } = await adminSupabase
          .from('checkins')
          .select('id')
          .eq('journey_id', journey.id)
          .eq('user_id', member.user_id)
          .eq('checkin_date', today)
          .single()

        if (!checkin) {
          await sendPush(
            member.user_id,
            'Check-in reminder',
            `Don't forget to check in for "${journey.title}" today.`,
            { journey_id: journey.id, type: 'checkin_reminder' }
          )
        }
      }
    }
  })
}

module.exports = { registerCheckinReminder }
