const router = require('express').Router()
const crypto = require('crypto')
const { requireAuth } = require('../middleware/auth')
const { adminSupabase } = require('../lib/supabase')
const { initializePayment, initiateRefund } = require('../lib/paystack')
const { sendPush } = require('../lib/push')

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
      callback_url: `${process.env.FRONTEND_URL}/payment-complete`
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
        await adminSupabase
          .from('journeys')
          .update({ status: 'open' })
          .eq('id', journey_id)
      }

      if (type === 'member') {
        const { data: journey } = await adminSupabase
          .from('journeys').select('*').eq('id', journey_id).single()

        if (journey && journey.current_participants >= journey.max_participants) {
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

    res.sendStatus(200)
  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message)
    res.sendStatus(200) // Always 200 to Paystack
  }
})

module.exports = router
