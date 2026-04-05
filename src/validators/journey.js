const Joi = require('joi')

const createJourney = Joi.object({
  title: Joi.string().min(3).max(200).required(),
  description: Joi.string().max(1000).optional().allow('', null),
  category: Joi.string()
    .valid('Learning', 'Fitness', 'Habit', 'Career', 'Faith', 'Finance', 'Custom')
    .required(),
  cover_image_url: Joi.string().uri().optional().allow('', null),
  duration_days: Joi.number().integer().min(7).max(90).required(),
  start_date: Joi.string().isoDate().optional().allow(null),
  max_participants: Joi.number().integer().min(2).max(50).optional(),
  stake_amount: Joi.number().min(0).optional(),
  milestones: Joi.array().items(
    Joi.object({
      title: Joi.string().min(2).max(200).required(),
      description: Joi.string().max(500).optional().allow('', null)
    })
  ).min(1).required()
})

module.exports = { createJourney }
