require('./config/env')
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const compression = require('compression')
const logger = require('./config/logger')
const { requestLogger } = require('./middleware/requestLogger')
const { errorHandler } = require('./middleware/errorHandler')
const { scheduleJobs } = require('./jobs')
const routes = require('./routes')

const app = express()

app.use(helmet())
app.use(compression())
// In development / Expo Go: allow all origins
// In production: lock down to your actual frontend URL
const corsOrigin = process.env.NODE_ENV === 'production' && process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL
  : true
app.use(cors({ origin: corsOrigin }))
app.use(requestLogger)

// Raw body for Paystack webhook signature verification — must come before express.json()
app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json' }))
app.use(express.json())

app.use('/api/v1', routes)
app.use(errorHandler)

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  logger.info(`Vouch API running on port ${PORT}`, { env: process.env.NODE_ENV || 'development' })
  scheduleJobs()
})
