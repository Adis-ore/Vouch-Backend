const COUNTRY_TIMEZONES = {
  // Africa
  'Nigeria': 'Africa/Lagos',
  'Ghana': 'Africa/Accra',
  'Kenya': 'Africa/Nairobi',
  'South Africa': 'Africa/Johannesburg',
  'Tanzania': 'Africa/Dar_es_Salaam',
  'Uganda': 'Africa/Kampala',
  'Ethiopia': 'Africa/Addis_Ababa',
  'Rwanda': 'Africa/Kigali',
  'Cameroon': 'Africa/Douala',
  'Senegal': 'Africa/Dakar',
  'Ivory Coast': 'Africa/Abidjan',
  "Côte d'Ivoire": 'Africa/Abidjan',
  'Egypt': 'Africa/Cairo',
  'Morocco': 'Africa/Casablanca',
  'Zimbabwe': 'Africa/Harare',
  'Zambia': 'Africa/Lusaka',
  'Botswana': 'Africa/Gaborone',
  'Namibia': 'Africa/Windhoek',
  // Europe
  'United Kingdom': 'Europe/London',
  'UK': 'Europe/London',
  'Germany': 'Europe/Berlin',
  'France': 'Europe/Paris',
  'Netherlands': 'Europe/Amsterdam',
  'Italy': 'Europe/Rome',
  'Spain': 'Europe/Madrid',
  // Americas
  'United States': 'America/New_York',
  'USA': 'America/New_York',
  'Canada': 'America/Toronto',
  'Brazil': 'America/Sao_Paulo',
  // Asia/Pacific
  'India': 'Asia/Kolkata',
  'UAE': 'Asia/Dubai',
  'Saudi Arabia': 'Asia/Riyadh',
  'Australia': 'Australia/Sydney',
  'Singapore': 'Asia/Singapore',
}

function getTimezoneForCountry(country) {
  if (!country) return 'Africa/Lagos'
  return COUNTRY_TIMEZONES[country] || 'Africa/Lagos'
}

// Returns date string YYYY-MM-DD in the given timezone
function getLocalDate(timezone, offsetDays = 0) {
  const d = new Date()
  if (offsetDays) d.setDate(d.getDate() + offsetDays)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Africa/Lagos',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

// Returns local hour (0–23) in the given timezone
function getLocalHour(timezone) {
  return parseInt(
    new Intl.DateTimeFormat('en', {
      timeZone: timezone || 'Africa/Lagos',
      hour: 'numeric',
      hour12: false,
    }).format(new Date()),
    10
  )
}

module.exports = { getTimezoneForCountry, getLocalDate, getLocalHour }
