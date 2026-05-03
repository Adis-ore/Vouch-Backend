const cron = require('node-cron')
const axios = require('axios')
const logger = require('../config/logger')

function registerKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/health`
    : null

  if (!url) {
    logger.info('[KEEP-ALIVE] No RENDER_EXTERNAL_URL set — skipping self-ping (local dev)')
    return
  }

  // Ping every 10 minutes so Render never hits the 15-min inactivity threshold
  cron.schedule('*/10 * * * *', async () => {
    try {
      const { data } = await axios.get(url, { timeout: 8000 })
      logger.info('[KEEP-ALIVE] Ping ok', { ts: data.ts })
    } catch (err) {
      logger.warn('[KEEP-ALIVE] Ping failed', { error: err.message })
    }
  })

  logger.info('[KEEP-ALIVE] Self-ping scheduled every 10 min', { url })
}

module.exports = { registerKeepAlive }
