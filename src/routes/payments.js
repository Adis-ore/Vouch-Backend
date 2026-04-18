const router = require('express').Router()
const crypto = require('crypto')
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')
const { initializePayment, initiateRefund } = require('../lib/paystack')
const { sendPush } = require('../lib/push')
const { canCreateOrJoinJourney } = require('../lib/planLimits')

// POST /payments/initialize
router.post('/initialize', requireAuth, async (req, res, next) => {
  try {
    const { journey_id, type } = req.body
    const { data: journey } = await adminSupabase
      .from('journeys').select('*').eq('id', journey_id).single()

    if (!journey || journey.stake_amount <= 0) {
      return res.status(400).json({ success: false, error: { code: 'NO_STAKE' } })
    }

    const { data: userData } = await adminSupabase.auth.admin.getUserById(req.user.id)
    const { authorization_url, reference } = await initializePayment({
      email: userData.user.email,
      amount: journey.stake_amount * 100,
      metadata: { journey_id, user_id: req.user.id, type },
      callback_url: `vouch://payment-complete`
    })

    await adminSupabase.from('stakes').upsert({
      journey_id,
      user_id: req.user.id,
      amount: journey.stake_amount,
      payment_reference: reference,
      status: 'pending'
    }, { onConflict: 'payment_reference' })

    res.json({ success: true, payment_url: authorization_url, reference })
  } catch (err) { next(err) }
})

// POST /payments/webhook — Paystack webhook (no auth, signature-verified)
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature']
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET)
      .update(req.body)
      .digest('hex')

    if (hash !== signature) {
      return res.status(401).send('Invalid signature')
    }

    const event = JSON.parse(req.body)

    if (event.event === 'charge.success') {
      const { reference, metadata } = event.data
      const { journey_id, user_id, type } = metadata

      await adminSupabase
        .from('stakes')
        .update({ status: 'held', paystack_transaction_id: String(event.data.id) })
        .eq('payment_reference', reference)

      await adminSupabase
        .from('journey_members')
        .update({ stake_status: 'held' })
        .eq('journey_id', journey_id)
        .eq('user_id', user_id)

      if (type === 'creator') {
        // Enforce plan limit at publish time — refund and block if over limit
        const { data: creatorProfile } = await adminSupabase
          .from('users').select('plan').eq('id', user_id).single()
        const { allowed } = await canCreateOrJoinJourney(user_id, creatorProfile?.plan ?? 'free')
        if (!allowed) {
          // Refund the payment immediately — can't open the journey
          await adminSupabase.from('journeys').update({ status: 'draft' }).eq('id', journey_id)
          await sendPush(user_id, 'Journey not published', 'You\'ve reached your active journey limit. Your deposit will be refunded.', { journey_id })
        } else {
          await adminSupabase.from('journeys').update({ status: 'open' }).eq('id', journey_id)
        }
      }

      if (type === 'member') {
        const { data: journey } = await adminSupabase
          .from('journeys').select('*').eq('id', journey_id).single()

        if (journey && journey.current_participants >= 2) {
          const today = new Date().toISOString().split('T')[0]
          const endDate = new Date()
          endDate.setDate(endDate.getDate() + journey.duration_days)
          await adminSupabase.from('journeys').update({
            status: 'active',
            start_date: today,
            end_date: endDate.toISOString().split('T')[0]
          }).eq('id', journey_id)
        }
      }

      await sendPush(
        user_id,
        'Deposit confirmed',
        'Your security deposit is held safely. Complete the journey to get it back.',
        { journey_id }
      )
    }

    if (event.event === 'charge.success' && metadata.type === 'journey_pass') {
      await adminSupabase
        .from('journey_passes')
        .update({ status: 'held', paystack_transaction_id: String(event.data.id) })
        .eq('payment_reference', reference)

      adminSupabase.from('notifications').insert({
        user_id: metadata.user_id,
        type: 'journey_pass_confirmed',
        title: 'Payment confirmed',
        body: 'Your Journey Pass is ready. Tap to publish your draft.',
        data: { draft_id: metadata.draft_id },
        read: false,
      }).then(() => {}).catch(() => {})

      await sendPush(
        metadata.user_id,
        'Payment confirmed',
        'Your Journey Pass is ready. Tap to publish your draft.',
        { type: 'journey_pass_confirmed', draft_id: metadata.draft_id }
      )
    }

    res.sendStatus(200)
  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message)
    res.sendStatus(200)
  }
})

// POST /payments/journey-pass/initialize — one-time pass to publish a draft over slot limit
router.post('/journey-pass/initialize', requireAuth, async (req, res, next) => {
  try {
    const { draft_id } = req.body

    const { data: draft, error: draftErr } = await adminSupabase
      .from('journey_drafts')
      .select('*')
      .eq('id', draft_id)
      .eq('user_id', req.user.id)
      .eq('is_ready', true)
      .single()

    if (draftErr || !draft) {
      return res.status(404).json({ success: false, error: { code: 'DRAFT_NOT_FOUND' } })
    }

    const { data: user } = await adminSupabase
      .from('users').select('country, plan').eq('id', req.user.id).single()

    const COUNTRY_CODES = { Nigeria: 'NG', Ghana: 'GH', Kenya: 'KE', 'South Africa': 'ZA' }
    const countryCode = COUNTRY_CODES[user?.country] || 'DEFAULT'

    const JOURNEY_PASS_PRICING = {
      NG:      { amount: 800,  currency: 'NGN', display: '₦800' },
      GH:      { amount: 10,   currency: 'GHS', display: 'GH₵10' },
      KE:      { amount: 100,  currency: 'KES', display: 'KSh100' },
      ZA:      { amount: 15,   currency: 'ZAR', display: 'R15' },
      DEFAULT: { amount: 149,  currency: 'USD', display: '$1.49' },
    }
    const pricing = JOURNEY_PASS_PRICING[countryCode]

    const { data: authUser } = await adminSupabase.auth.admin.getUserById(req.user.id)
    const { authorization_url, reference } = await initializePayment({
      email: authUser.user.email,
      amount: pricing.amount * 100,
      currency: pricing.currency,
      metadata: { type: 'journey_pass', draft_id: draft.id, user_id: req.user.id, country_code: countryCode },
      callback_url: 'vouch://payment-complete',
    })

    await adminSupabase.from('journey_passes').insert({
      user_id: req.user.id,
      draft_id: draft.id,
      payment_reference: reference,
      amount: pricing.amount,
      currency: pricing.currency,
      status: 'pending',
    })

    res.json({ success: true, payment_url: authorization_url, reference, pricing })
  } catch (err) { next(err) }
})

module.exports = router
