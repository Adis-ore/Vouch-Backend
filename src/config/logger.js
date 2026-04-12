const winston = require('winston')
const fs = require('fs')
const path = require('path')

// Ensure logs directory exists (needed on first deploy / fresh environments)
const logsDir = path.join(process.cwd(), 'logs')
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true })

const { combine, timestamp, printf, colorize, errors } = winston.format

// Pretty format for development console
const devFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const ts = new Date(timestamp).toTimeString().split(' ')[0] // HH:MM:SS
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''
  return `[${ts}] ${level.toUpperCase().padEnd(5)}  ${stack || message}${metaStr}`
})

const logger = winston.createLogger({
  level: 'info',
  format: combine(
    errors({ stack: true }),
    timestamp()
  ),
  transports: [
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: combine(timestamp(), winston.format.json())
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: combine(timestamp(), winston.format.json())
    }),
  ],
})

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: combine(colorize(), timestamp(), devFormat),
  }))
}

module.exports = logger
