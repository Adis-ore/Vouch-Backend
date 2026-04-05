const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')

// GET /search/journeys
router.get('/journeys', requireAuth, async (req, res, next) => {
  try {
    const { q, category, country, region, min_stake, max_stake, limit = 20, offset = 0 } = req.query

    let query = adminSupabase
      .from('journeys')
      .select(
        '*, creator:users!creator_id(id, full_name, avatar_url, country, region, reputation_score), journey_members(count)',
        { count: 'exact' }
      )
      .eq('status', 'open')

    if (q) query = query.textSearch('search_vector', q, { type: 'websearch' })
    if (category) query = query.eq('category', category)
    if (country) query = query.eq('country', country)
    if (region) query = query.eq('region', region)
    if (min_stake) query = query.gte('stake_amount', parseFloat(min_stake))
    if (max_stake) query = query.lte('stake_amount', parseFloat(max_stake))

    const { data, error, count } = await query
      .order('is_featured', { ascending: false })
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (error) throw error
    res.json({ success: true, journeys: data, total: count })
  } catch (err) { next(err) }
})

module.exports = router
