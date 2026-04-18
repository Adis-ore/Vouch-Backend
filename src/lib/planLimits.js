const { adminSupabase } = require('./supabase')

const PLAN_LIMITS = { free: 3, pro: 5, elite: 10 }

/**
 * getActiveJourneyCount — counts live (open/active) journeys for a user.
 * pending_payment / draft journeys do NOT count.
 */
async function getActiveJourneyCount(userId) {
  const { count } = await adminSupabase
    .from('journey_members')
    .select('journey:journeys!inner(status)', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'active')
    .in('journey.status', ['open', 'active'])
  return count ?? 0
}

/**
 * canCreateOrJoinJourney — returns whether the user has a free slot.
 */
async function canCreateOrJoinJourney(userId, plan) {
  const limit = PLAN_LIMITS[plan] ?? 3
  const activeCount = await getActiveJourneyCount(userId)
  return { allowed: activeCount < limit, count: activeCount, limit }
}

module.exports = { canCreateOrJoinJourney, getActiveJourneyCount, PLAN_LIMITS }
