const axios = require('axios')

const paystackClient = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json'
  }
})

async function initializePayment({ email, amount, metadata, callback_url }) {
  const { data } = await paystackClient.post('/transaction/initialize', {
    email,
    amount,
    metadata,
    callback_url
  })
  return {
    authorization_url: data.data.authorization_url,
    access_code: data.data.access_code,
    reference: data.data.reference
  }
}

async function initiateRefund({ transaction, amount }) {
  const { data } = await paystackClient.post('/refund', { transaction, amount })
  return data.data
}

module.exports = { initializePayment, initiateRefund }
