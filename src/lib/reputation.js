const { adminSupabase } = require('./supabase')

/**
 * updateReputation — recalculates a user's reputation from all verifications
 * they've ever received. Called after every approve or flag verdict.
 *
 * Formula: approvals / (approvals + flags) * 100
 * New users with no verdicts default to 100.
 */
async function updateReputation(checkinOwnerId) {
  const { data: verifications } = await adminSupabase
    .from('checkin_verifications')
    .select('verdict, checkin:checkins!inner(user_id)')
    .eq('checkin.user_id', checkinOwnerId)

  const approvals = (verifications || []).filter(v => v.verdict === 'approve').length
  const flags     = (verifications || []).filter(v => v.verdict === 'flag').length
  const total     = approvals + flags

  const reputationScore = total === 0
    ? 100
    : Math.round((approvals / total) * 100)

  await adminSupabase.from('users').update({
    reputation_score: reputationScore,
    total_approvals_received: approvals,
    total_flags_received: flags,
  }).eq('id', checkinOwnerId)

  return reputationScore
}

module.exports = { updateReputation }
