function scoreJourney(journey, currentUser) {
  let score = 0

  if (journey.country === currentUser.country) score += 15
  if (journey.region === currentUser.region) score += 25
  if (journey.stake_amount === 0) score += 5

  // Recency boost — -2 per day old
  const hoursOld = (Date.now() - new Date(journey.created_at).getTime()) / 3600000
  score -= Math.floor(hoursOld / 24) * 2

  if (journey.is_featured) score += 50

  return score
}

module.exports = { scoreJourney }
