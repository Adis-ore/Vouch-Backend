const { adminSupabase } = require('./supabase')

/**
 * Write a record to journey_history for one user.
 * outcome: 'completed' | 'abandoned' | 'auto_removed' | 'left'
 */
async function writeHistory(userId, journey, member, outcome) {
  try {
    await adminSupabase.from('journey_history').insert({
      user_id: userId,
      journey_id: journey.id,
      journey_title: journey.title,
      category: journey.category || null,
      duration_days: journey.duration_days || 0,
      outcome,
      my_role: member?.role || 'member',
      total_checkins: member?.total_checkins || 0,
      stake_amount: parseFloat(journey.stake_amount) || 0,
      stake_outcome: member?.stake_status || 'none',
      joined_at: member?.joined_at || null,
      ended_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[HISTORY] Write failed for user', userId, err.message)
  }
}

module.exports = { writeHistory }
