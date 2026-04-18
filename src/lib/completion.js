const { adminSupabase } = require('./supabase')
const { sendPush } = require('./push')
const { processStakeRefund } = require('./refund')
const { checkAndAwardBadges } = require('./badges')
const { writeHistory } = require('./historyHelper')

/**
 * completeJourneyForUser — marks one member as having finished their journey.
 *
 * Called from:
 *   1. checkins.js — when total_checkins reaches duration_days (real-time)
 *   2. completionChecker.js cron — for time-based end (midnight sweep)
 *
 * Idempotent: if member is already completed, returns immediately.
 */
async function completeJourneyForUser(journeyId, userId) {
  try {
    const { data: member } = await adminSupabase
      .from('journey_members')
      .select('*, journey:journeys(*)')
      .eq('journey_id', journeyId)
      .eq('user_id', userId)
      .single()

    if (!member) return { completed: false, error: 'not_member' }
    if (member.status === 'completed') return { completed: false, alreadyDone: true }

    const journey = member.journey
    const completionPercent = journey?.duration_days > 0
      ? Math.min(100, Math.round(((member.total_checkins || 0) / journey.duration_days) * 100))
      : 100

    // Mark member completed
    await adminSupabase
      .from('journey_members')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('journey_id', journeyId)
      .eq('user_id', userId)

    // Increment journeys_completed
    const { data: u } = await adminSupabase
      .from('users').select('journeys_completed').eq('id', userId).single()
    await adminSupabase
      .from('users')
      .update({ journeys_completed: (u?.journeys_completed || 0) + 1 })
      .eq('id', userId)

    // Stake refund (tier-based)
    let stakeReturned = false
    if (member.stake_status === 'held') {
      const refundResult = await processStakeRefund({ journeyId, userId, completionPercent })
      stakeReturned = (refundResult?.refundPercent || 0) > 0
    }

    // Write to history
    const { data: updatedStake } = await adminSupabase
      .from('stakes').select('status').eq('journey_id', journeyId).eq('user_id', userId).maybeSingle()
    await writeHistory(userId, journey, {
      ...member,
      stake_status: updatedStake?.status ?? member.stake_status,
    }, 'completed').catch(() => {})

    // Award badges for this completion
    await checkAndAwardBadges(userId, { event: 'journey_complete', stakeReturned })

    // In-app completion notification
    adminSupabase.from('notifications').insert({
      user_id: userId,
      type: 'journey_completed',
      title: 'Journey completed!',
      body: `You completed "${journey?.title}". Check your profile for new badges.`,
      data: { route: 'journey', journey_id: journeyId },
      read: false,
    }).then(() => {}).catch(() => {})

    sendPush(
      userId,
      'Journey completed!',
      `You completed "${journey?.title}". Great work.`,
      { journey_id: journeyId, type: 'journey_completed' }
    ).catch(() => {})

    // If ALL active members are now done, mark journey as completed globally
    const { count: stillActive } = await adminSupabase
      .from('journey_members')
      .select('*', { count: 'exact', head: true })
      .eq('journey_id', journeyId)
      .eq('status', 'active')

    if ((stillActive || 0) === 0) {
      await adminSupabase
        .from('journeys')
        .update({ status: 'completed' })
        .eq('id', journeyId)
    }

    return { completed: true, completionPercent, stakeReturned }
  } catch (err) {
    console.error('[COMPLETION] completeJourneyForUser error', err.message)
    return { completed: false, error: err.message }
  }
}

module.exports = { completeJourneyForUser }
