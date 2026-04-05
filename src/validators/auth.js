const Joi = require('joi')

const registerProfile = Joi.object({
  full_name: Joi.string().min(2).max(100).required(),
  bio: Joi.string().max(500).optional().allow('', null),
  avatar_url: Joi.string().uri().optional().allow('', null),
  phone: Joi.string().optional().allow('', null),
  country: Joi.string().optional(),
  region: Joi.string().optional()
})

module.exports = { registerProfile }
