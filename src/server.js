require('./config/env')
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const compression = require('compression')
const { errorHandler } = require('./middleware/errorHandler')
const { scheduleJobs } = require('./jobs')
const routes = require('./routes')

const app = express()

app.use(helmet())
app.use(compression())
app.use(cors({ origin: process.env.FRONTEND_URL }))

// Raw body for Paystack webhook signature verification — must come before express.json()
app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json' }))
app.use(express.json())

app.use('/api/v1', routes)
app.use(errorHandler)

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Vouch API running on port ${PORT}`)
  scheduleJobs()
})
