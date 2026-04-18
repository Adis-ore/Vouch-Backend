const { adminSupabase } = require('./supabase')
const { initiateRefund } = require('./paystack')

function getRefundPercent(completionPercent) {
  if (completionPercent >= 100) return 100
  if (completionPercent >= 90)  return 95
  if (completionPercent >= 75)  return 75
  return 0
}

/**
 * processStakeRefund — calculate tier-based refund and execute via Paystack.
 * @param {string} journeyId
 * @param {string} userId
 * @param {number} completionPercent  0–100, member's personal checkin percent
 */
async function processStakeRefund({ journeyId, userId, completionPercent }) {
  const { data: stake } = await adminSupabase
    .from('stakes')
    .select('*')
    .eq('journey_id', journeyId)
    .eq('user_id', userId)
    .eq('status', 'held')
    .single()

  if (!stake) return  // no held stake — nothing to do

  const refundPct    = getRefundPercent(completionPercent)
  const refundAmount = Math.round(stake.amount * refundPct / 100)
  const forfeitAmount = stake.amount - refundAmount

  if (refundPct === 0 || refundAmount === 0) {
    await adminSupabase.from('stakes').update({
      status: 'forfeited',
      refund_percent: 0,
      refund_amount: 0,
      forfeit_amount: stake.amount,
      processed_at: new Date().toISOString(),
    }).eq('id', stake.id)
    return
  }

  try {
    const result = await initiateRefund({
      transaction: stake.paystack_transaction_id,
      amount: refundAmount * 100,  // Paystack expects kobo
    })

    await adminSupabase.from('stakes').update({
      status: 'returned',
      refund_percent: refundPct,
      refund_amount: refundAmount,
      forfeit_amount: forfeitAmount,
      paystack_refund_id: result?.id ?? null,
      returned_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
    }).eq('id', stake.id)
  } catch (err) {
    console.error(`[REFUND] Failed for stake ${stake.id}:`, err.message)

    await adminSupabase.from('stakes').update({
      status: 'refund_failed',
      refund_percent: refundPct,
      refund_amount: refundAmount,
      forfeit_amount: forfeitAmount,
      processed_at: new Date().toISOString(),
    }).eq('id', stake.id)

    await adminSupabase.from('refund_failures').insert({
      stake_id: stake.id,
      journey_id: journeyId,
      user_id: userId,
      error_message: err.message,
      attempted_at: new Date().toISOString(),
      resolved: false,
    }).catch(() => {})

    await adminSupabase.from('admin_notifications').insert({
      type: 'refund_failed',
      title: 'Refund failed',
      body: `Stake ${stake.id} for user ${userId} on journey ${journeyId} — ${err.message}`,
      data: { stake_id: stake.id, journey_id: journeyId, user_id: userId },
      resolved: false,
    }).catch(() => {})
  }
}

module.exports = { getRefundPercent, processStakeRefund }
