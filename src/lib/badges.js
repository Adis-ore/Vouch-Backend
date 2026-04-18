const { adminSupabase } = require('./supabase')
const { sendPush } = require('./push')

const BADGE_DEFINITIONS = [
  // Check-in milestones
  { key: 'first_checkin', name: 'First Step',       body: 'You submitted your first check-in!' },
  { key: 'proof_5',       name: 'Proof Poster',     body: 'You attached proof on 5 check-ins.' },
  { key: 'proof_20',      name: 'Show Your Work',   body: '20 check-ins with proof. Accountability unlocked.' },
  // Streak milestones
  { key: 'streak_3',      name: 'Getting Started',  body: 'You hit a 3-day streak!' },
  { key: 'streak_7',      name: 'On Fire',          body: 'You hit a 7-day streak!' },
  { key: 'streak_14',     name: 'Two Weeks Strong', body: '14 days straight. Serious.' },
  { key: 'streak_30',     name: 'Unstoppable',      body: '30-day streak achieved!' },
  { key: 'streak_60',     name: 'Elite',            body: '60 consecutive days. Legendary.' },
  { key: 'streak_100',    name: 'Centurion',        body: '100 days. You are built different.' },
  // Journey completions
  { key: 'first_journey',  name: 'Finisher',        body: 'You completed your first journey!' },
  { key: 'journeys_3',     name: 'Triple Crown',    body: 'Three journeys completed.' },
  { key: 'journeys_5',     name: 'Consistent',      body: 'Five journeys completed.' },
  { key: 'journeys_10',    name: 'Veteran',          body: 'Ten journeys completed.' },
  { key: 'stake_survivor', name: 'Stake Survivor',  body: 'Completed a journey with a stake and got your money back.' },
  // Reputation
  { key: 'trusted',        name: 'Trusted',         body: 'Your reputation score hit 80+.' },
  { key: 'highly_trusted', name: 'Highly Trusted',  body: 'Your reputation score hit 95+.' },
]

const BADGE_MAP = Object.fromEntries(BADGE_DEFINITIONS.map(b => [b.key, b]))

const STREAK_THRESHOLDS = { streak_3: 3, streak_7: 7, streak_14: 14, streak_30: 30, streak_60: 60, streak_100: 100 }

/**
 * checkAndAwardBadges — checks and awards any newly-earned badges.
 *
 * event: 'checkin_submitted' | 'streak_updated' | 'journey_complete' | 'reputation_updated'
 * options: { streak: number, stakeReturned: boolean }
 */
async function checkAndAwardBadges(userId, { event, streak, stakeReturned } = {}) {
  try {
    const { data: existing } = await adminSupabase
      .from('badges').select('key').eq('user_id', userId)
    const owned = new Set((existing || []).map(b => b.key))

    const award = async (key) => {
      if (owned.has(key)) return
      const def = BADGE_MAP[key]
      if (!def) return
      try {
        await adminSupabase.from('badges').insert({ user_id: userId, key, name: def.name, earned_at: new Date().toISOString() })
        owned.add(key)
        adminSupabase.from('notifications').insert({
          user_id: userId,
          type: 'badge_earned',
          title: `Badge earned: ${def.name}`,
          body: def.body,
          data: { badge_key: key },
          read: false,
        }).then(() => {}).catch(() => {})
        sendPush(userId, `Badge earned: ${def.name}`, def.body, { badge_key: key }).catch(() => {})
      } catch (_) {}
    }

    if (event === 'checkin_submitted') {
      const { count: total } = await adminSupabase
        .from('checkins').select('*', { count: 'exact', head: true }).eq('user_id', userId)
      if ((total || 0) >= 1) await award('first_checkin')

      const { count: withProof } = await adminSupabase
        .from('checkins').select('*', { count: 'exact', head: true })
        .eq('user_id', userId).not('proof_url', 'is', null)
      if ((withProof || 0) >= 5)  await award('proof_5')
      if ((withProof || 0) >= 20) await award('proof_20')
    }

    if (event === 'streak_updated' && typeof streak === 'number') {
      for (const [key, threshold] of Object.entries(STREAK_THRESHOLDS)) {
        if (streak >= threshold) await award(key)
      }
    }

    if (event === 'journey_complete') {
      const { count: completed } = await adminSupabase
        .from('journey_members').select('*', { count: 'exact', head: true })
        .eq('user_id', userId).eq('status', 'completed')
      const n = completed || 0
      if (n >= 1)  await award('first_journey')
      if (n >= 3)  await award('journeys_3')
      if (n >= 5)  await award('journeys_5')
      if (n >= 10) await award('journeys_10')
      if (stakeReturned) await award('stake_survivor')
    }

    if (event === 'reputation_updated') {
      const { data: u } = await adminSupabase
        .from('users').select('reputation_score').eq('id', userId).single()
      const score = u?.reputation_score || 0
      if (score >= 80) await award('trusted')
      if (score >= 95) await award('highly_trusted')
    }
  } catch (err) {
    console.error('[BADGES] error', err.message)
  }
}

module.exports = { checkAndAwardBadges, BADGE_DEFINITIONS }
