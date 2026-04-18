const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')
const { initializePayment } = require('../lib/paystack')
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
    if (!journey.stake_amount || journey.stake_amount <= 0) {
      // No payment needed — just open the journey directly
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

module.exports = router
