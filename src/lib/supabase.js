const { createClient: _createClient } = require('@supabase/supabase-js')

const adminSupabase = _createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function createClient() {
  return _createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

module.exports = { adminSupabase, createClient }
