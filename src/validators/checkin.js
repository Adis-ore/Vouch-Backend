const Joi = require('joi')

const submitCheckin = Joi.object({
  journey_id: Joi.string().uuid().required(),
  note: Joi.string().min(20).max(2000).required(),
  proof_url: Joi.string().uri().optional().allow('', null),
  proof_type: Joi.string().valid('image', 'voice').optional().allow(null),
  next_step: Joi.string().max(500).optional().allow('', null)
})

module.exports = { submitCheckin }
