const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')
const { initializePayment } = require('../lib/paystack')
const { canCreateOrJoinJourney, getActiveJourneyCount, PLAN_LIMITS } = require('../lib/planLimits')
const logger = require('../config/logger')

// GET /drafts — form drafts + pending-payment journeys
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const [{ data: formDrafts }, { data: journeyDrafts }] = await Promise.all([
      adminSupabase
        .from('journey_drafts')
        .select('*')
        .eq('user_id', req.user.id)
        .order('updated_at', { ascending: false }),
      adminSupabase
        .from('journeys')
        .select('*')
        .eq('creator_id', req.user.id)
        .in('status', ['draft', 'pending_payment'])
        .order('created_at', { ascending: false }),
    ])
    res.json({ success: true, data: { formDrafts: formDrafts || [], journeyDrafts: journeyDrafts || [] } })
  } catch (err) { next(err) }
})

// POST /drafts/form — create or update an incomplete form draft
router.post('/form', requireAuth, async (req, res, next) => {
  try {
    const { draft_id, step, form_data } = req.body

    if (draft_id) {
      const { data, error } = await adminSupabase
        .from('journey_drafts')
        .update({ step: step || 1, form_data: form_data || {}, updated_at: new Date().toISOString() })
        .eq('id', draft_id)
        .eq('user_id', req.user.id)
        .select()
        .single()
      if (error) throw error
      return res.json({ success: true, data: { draft: data } })
    }

    const { data, error } = await adminSupabase
      .from('journey_drafts')
      .insert({ user_id: req.user.id, step: step || 1, form_data: form_data || {} })
      .select()
      .single()
    if (error) throw error
    logger.info('[DRAFTS] Form draft saved', { userId: req.user.id, draftId: data.id })
    res.json({ success: true, data: { draft: data } })
  } catch (err) { next(err) }
})

// DELETE /drafts/form/:id — delete a form draft
router.delete('/form/:id', requireAuth, async (req, res, next) => {
  try {
    await adminSupabase
      .from('journey_drafts')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
    res.json({ success: true })
  } catch (err) { next(err) }
})

// PATCH /drafts/journey/:id/shelve — move a pending_payment journey to draft status
router.patch('/journey/:id/shelve', requireAuth, async (req, res, next) => {
  try {
    const { error } = await adminSupabase
      .from('journeys')
      .update({ status: 'draft' })
      .eq('id', req.params.id)
      .eq('creator_id', req.user.id)
      .eq('status', 'pending_payment')
    if (error) throw error
    logger.info('[DRAFTS] Journey shelved as draft', { userId: req.user.id, journeyId: req.params.id })
    res.json({ success: true })
  } catch (err) { next(err) }
})

// POST /drafts/journey/:id/retry-payment — generate a fresh payment link for a draft journey
router.post('/journey/:id/retry-payment', requireAuth, async (req, res, next) => {
  try {
    const { data: journey, error } = await adminSupabase
      .from('journeys')
      .select('*')
      .eq('id', req.params.id)
      .eq('creator_id', req.user.id)
      .in('status', ['draft', 'pending_payment'])
      .single()

    if (error || !journey) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Draft journey not found.' } })
    }

    // Check plan limits before publishing — the draft doesn't hold a slot yet
    const { data: creator } = await adminSupabase
      .from('users').select('plan').eq('id', req.user.id).single()
    const { allowed, limit: planLimit } = await canCreateOrJoinJourney(req.user.id, creator?.plan ?? 'free')
    if (!allowed) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'JOURNEY_LIMIT_REACHED',
          message: `You already have ${planLimit} active journeys on the ${creator?.plan ?? 'free'} plan. Complete or leave one before publishing this draft.`
        }
      })
    }

    if (!journey.stake_amount || journey.stake_amount <= 0) {
      // No payment needed — publish directly
      await adminSupabase.from('journeys').update({ status: 'open' }).eq('id', journey.id)
      return res.json({ success: true, payment_url: null })
    }

    // Restore to pending_payment and issue a fresh Paystack link
    await adminSupabase.from('journeys').update({ status: 'pending_payment' }).eq('id', journey.id)

    const { data: userData } = await adminSupabase.auth.admin.getUserById(req.user.id)
    const { authorization_url, reference } = await initializePayment({
      email: userData.user.email,
      amount: journey.stake_amount * 100,
      metadata: { journey_id: journey.id, user_id: req.user.id, type: 'creator' },
      callback_url: 'vouch://payment-complete',
    })
    await adminSupabase.from('stakes').upsert({
      journey_id: journey.id,
      user_id: req.user.id,
      amount: journey.stake_amount,
      payment_reference: reference,
      status: 'pending',
    }, { onConflict: 'payment_reference' })

    logger.info('[DRAFTS] Retry payment link issued', { userId: req.user.id, journeyId: journey.id })
    res.json({ success: true, payment_url: authorization_url })
  } catch (err) { next(err) }
})

// ─── New-style publishable drafts ───────────────────────────────────────────

// POST /drafts/save — save (create or update) a publishable draft. No slot check.
router.post('/save', requireAuth, async (req, res, next) => {
  try {
    const { draft_id, title, description, category, cover_image_url,
            duration_days, max_participants, is_private, stake_amount, milestones } = req.body

    const fields = {
      title, description, category, cover_image_url,
      duration_days: duration_days ? parseInt(duration_days) : null,
      max_participants: max_participants ? parseInt(max_participants) : null,
      is_private: is_private === true || is_private === 'true',
      stake_amount: parseFloat(stake_amount) || 0,
      milestones: milestones || [],
      is_ready: true,
      updated_at: new Date().toISOString(),
    }

    if (draft_id) {
      const { data, error } = await adminSupabase
        .from('journey_drafts')
        .update(fields)
        .eq('id', draft_id)
        .eq('user_id', req.user.id)
        .select().single()
      if (error) throw error
      return res.json({ success: true, draft: data })
    }

    const { data, error } = await adminSupabase
      .from('journey_drafts')
      .insert({ user_id: req.user.id, ...fields })
      .select().single()
    if (error) throw error
    logger.info('[DRAFTS] Draft saved', { userId: req.user.id, draftId: data.id })
    res.status(201).json({ success: true, draft: data })
  } catch (err) { next(err) }
})

// POST /drafts/:draftId/publish — publish a saved draft (slot check + journey pass check)
router.post('/:draftId/publish', requireAuth, async (req, res, next) => {
  try {
    const { data: draft, error: draftErr } = await adminSupabase
      .from('journey_drafts')
      .select('*')
      .eq('id', req.params.draftId)
      .eq('user_id', req.user.id)
      .eq('is_ready', true)
      .single()

    if (draftErr || !draft) {
      return res.status(404).json({ success: false, error: { code: 'DRAFT_NOT_FOUND' } })
    }
    if (!draft.title || !draft.duration_days) {
      return res.status(400).json({ success: false, error: { code: 'DRAFT_INCOMPLETE', message: 'Draft is missing title or duration.' } })
    }
    if (!draft.milestones || draft.milestones.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'DRAFT_INCOMPLETE', message: 'Add at least one milestone before publishing.' } })
    }

    const { data: user } = await adminSupabase
      .from('users').select('plan, country, region').eq('id', req.user.id).single()

    const activeCount = await getActiveJourneyCount(req.user.id)
    const planLimit = PLAN_LIMITS[user?.plan] ?? PLAN_LIMITS.free
    const hasSlot = activeCount < planLimit

    // Check for a valid journey pass for this draft
    const { data: journeyPass } = await adminSupabase
      .from('journey_passes')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('draft_id', draft.id)
      .eq('status', 'held')
      .maybeSingle()

    if (!hasSlot && !journeyPass) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'JOURNEY_LIMIT_REACHED',
          message: `You have ${activeCount} active journeys. Your ${user?.plan ?? 'free'} plan allows ${planLimit}.`,
          current_plan: user?.plan ?? 'free',
          active_count: activeCount,
          plan_limit: planLimit,
          upgrade_required: true,
        }
      })
    }

    const amount = parseFloat(draft.stake_amount) || 0

    const { data: journey, error: journeyErr } = await adminSupabase
      .from('journeys')
      .insert({
        creator_id: req.user.id,
        title: draft.title,
        description: draft.description || null,
        category: draft.category || null,
        cover_image_url: draft.cover_image_url || null,
        duration_days: draft.duration_days,
        max_participants: draft.max_participants || 20,
        is_private: draft.is_private || false,
        stake_amount: amount,
        status: amount > 0 ? 'pending_payment' : 'open',
        country: user?.country || null,
        region: user?.region || null,
        current_participants: 1,
      })
      .select().single()

    if (journeyErr) throw journeyErr

    await adminSupabase.from('journey_members').insert({
      journey_id: journey.id,
      user_id: req.user.id,
      role: 'creator',
      status: 'active',
      stake_status: amount > 0 ? 'pending' : 'none',
    })

    if (draft.milestones.length > 0) {
      await adminSupabase.from('milestones').insert(
        draft.milestones.map((m, i) => ({
          journey_id: journey.id,
          week_number: i + 1,
          title: m.title,
          description: m.description || null,
          is_unlocked: i === 0,
        }))
      )
    }

    // If journey pass was used: activate it and link to the new journey
    if (journeyPass) {
      const endDate = new Date()
      endDate.setDate(endDate.getDate() + draft.duration_days)
      await adminSupabase.from('journey_passes').update({
        journey_id: journey.id,
        draft_id: null,
        status: 'active',
        expires_at: endDate.toISOString(),
      }).eq('id', journeyPass.id)
    }

    // Delete the draft — it's been published
    await adminSupabase.from('journey_drafts').delete().eq('id', draft.id)

    // If stake required, generate payment URL
    let payment_url = null
    if (amount > 0) {
      const { data: authUser } = await adminSupabase.auth.admin.getUserById(req.user.id)
      const { authorization_url, reference } = await initializePayment({
        email: authUser.user.email,
        amount: amount * 100,
        metadata: { journey_id: journey.id, user_id: req.user.id, type: 'creator' },
        callback_url: 'vouch://payment-complete',
      })
      payment_url = authorization_url
      await adminSupabase.from('stakes').insert({
        journey_id: journey.id, user_id: req.user.id,
        amount, payment_reference: reference, status: 'pending',
      })
    }

    logger.info('[DRAFTS] Draft published', { userId: req.user.id, journeyId: journey.id, usedPass: !!journeyPass })
    res.status(201).json({
      success: true,
      journey,
      payment_url,
      used_journey_pass: !!journeyPass,
      slots_remaining: hasSlot ? planLimit - activeCount - 1 : 0,
    })
  } catch (err) { next(err) }
})

// DELETE /drafts/:draftId — delete a publishable draft
router.delete('/:draftId', requireAuth, async (req, res, next) => {
  try {
    await adminSupabase
      .from('journey_drafts')
      .delete()
      .eq('id', req.params.draftId)
      .eq('user_id', req.user.id)
      .eq('is_ready', true)
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
