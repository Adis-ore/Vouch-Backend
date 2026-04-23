const router = require('express').Router()
const logger = require('../config/logger')
const { requireAuth } = require('../middleware/auth')
const { adminSupabase, anonSupabase } = require('../lib/supabase')
const { getTimezoneForCountry } = require('../lib/timezones')

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map raw Supabase auth error messages → clean user-facing messages + HTTP status.
 * Supabase doesn't use consistent error codes so we match on message strings.
 */
function mapAuthError(message = '') {
  const m = message.toLowerCase()

  if (m.includes('user already registered') || m.includes('already been registered'))
    return { status: 409, code: 'EMAIL_EXISTS', message: 'An account with this email already exists.' }

  if (m.includes('invalid login credentials') || m.includes('invalid credentials'))
    return { status: 401, code: 'INVALID_CREDENTIALS', message: 'Incorrect email or password.' }

  if (m.includes('email not confirmed'))
    return { status: 403, code: 'EMAIL_NOT_CONFIRMED', message: 'Please confirm your email address before signing in.' }

  if (m.includes('password should be at least'))
    return { status: 400, code: 'WEAK_PASSWORD', message: 'Password must be at least 6 characters.' }

  if (m.includes('unable to validate email address') || m.includes('invalid email'))
    return { status: 400, code: 'INVALID_EMAIL', message: 'Please enter a valid email address.' }

  if (m.includes('token has expired') || m.includes('refresh_token_not_found'))
    return { status: 401, code: 'SESSION_EXPIRED', message: 'Your session has expired. Please sign in again.' }

  if (m.includes('rate limit') || m.includes('too many requests'))
    return { status: 429, code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a moment and try again.' }

  if (m.includes('email link is invalid or has expired'))
    return { status: 400, code: 'INVALID_LINK', message: 'This reset link has expired. Please request a new one.' }

  // Fallback — expose raw message for unknown cases
  return { status: 400, code: 'AUTH_ERROR', message }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /auth/signup
router.post('/signup', async (req, res, next) => {
  try {
    const { email, password, full_name, bio, country, region, phone } = req.body

    // Input validation
    if (!email || !password || !full_name) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'Email, password and full name are required.' }
      })
    }

    const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRx.test(email.trim())) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_EMAIL', message: 'Please enter a valid email address.' }
      })
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 6 characters.' }
      })
    }

    logger.info('[AUTH] Signup attempt', { email: email.trim() })

    // 1. Create Supabase auth account
    const { data: authData, error: authError } = await anonSupabase.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { full_name: full_name.trim() } }
    })

    if (authError) {
      const mapped = mapAuthError(authError.message)
      logger.warn('[AUTH] Signup auth error', { email: email.trim(), code: mapped.code, raw: authError.message })
      return res.status(mapped.status).json({ success: false, error: { code: mapped.code, message: mapped.message } })
    }

    const { user, session } = authData

    // Supabase sometimes returns a dummy user instead of an error for existing emails
    // when email confirmation is OFF — detect by checking identities array
    if (!user.identities || user.identities.length === 0) {
      logger.warn('[AUTH] Signup blocked — email already registered', { email: email.trim() })
      return res.status(409).json({
        success: false,
        error: { code: 'EMAIL_EXISTS', message: 'An account with this email already exists.' }
      })
    }

    logger.info('[AUTH] Supabase auth account created', { userId: user.id, email: email.trim() })

    // 2. Upsert profile row (handles retried signups idempotently)
    const userCountry = country || 'Nigeria'
    const { data: profile, error: profileError } = await adminSupabase
      .from('users')
      .upsert({
        id: user.id,
        full_name: full_name.trim(),
        bio: bio || null,
        country: userCountry,
        region: region || 'Lagos',
        phone: phone || null,
        timezone: getTimezoneForCountry(userCountry),
      }, { onConflict: 'id' })
      .select()
      .single()

    if (profileError) {
      logger.error('[AUTH] Profile upsert failed', { userId: user.id, error: profileError.message })
      return res.status(500).json({
        success: false,
        error: { code: 'PROFILE_FAILED', message: 'Account created but profile setup failed. Please try signing in.' }
      })
    }

    // Send welcome notification
    adminSupabase.from('notifications').insert({
      user_id: user.id,
      type: 'welcome',
      title: `Welcome to Vouch, ${full_name.trim().split(' ')[0]}`,
      body: "You're all set. Create your first journey or find one to join — your partner is out there.",
      data: { route: 'discover' },
      read: false,
    }).then(() => {}).catch(() => {}) // non-blocking

    // session is null when Supabase email confirmation is ON
    if (!session) {
      logger.info('[AUTH] Signup complete — awaiting email confirmation', { userId: user.id })
      return res.status(201).json({
        success: true,
        data: {
          user: profile,
          session: null,
          message: 'Account created. Check your email to confirm before signing in.'
        }
      })
    }

    logger.info('[AUTH] Signup complete — session issued', { userId: user.id })
    res.status(201).json({
      success: true,
      data: {
        user: profile,
        session: {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_at: session.expires_at,
          expires_in: session.expires_in,
        }
      }
    })
  } catch (err) { next(err) }
})

// POST /auth/signin
router.post('/signin', async (req, res, next) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'Email and password are required.' }
      })
    }

    logger.info('[AUTH] Signin attempt', { email: email.trim() })

    const { data, error } = await anonSupabase.auth.signInWithPassword({
      email: email.trim(),
      password
    })

    if (error) {
      const mapped = mapAuthError(error.message)
      logger.warn('[AUTH] Signin failed', { email: email.trim(), code: mapped.code, raw: error.message })
      return res.status(mapped.status).json({ success: false, error: { code: mapped.code, message: mapped.message } })
    }

    logger.info('[AUTH] Signin success — fetching profile', { userId: data.user.id })

    const { data: profile, error: profileError } = await adminSupabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .single()

    if (profileError) {
      // Still sign them in even without a profile row
      logger.warn('[AUTH] Profile fetch failed on signin', { userId: data.user.id, error: profileError.message })
    }

    logger.info('[AUTH] Signin complete', { userId: data.user.id })
    res.json({
      success: true,
      data: {
        user: profile || { id: data.user.id, email: data.user.email },
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at,
          expires_in: data.session.expires_in,
        }
      }
    })
  } catch (err) { next(err) }
})

// POST /auth/refresh
router.post('/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body

    if (!refresh_token) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'refresh_token is required.' }
      })
    }

    logger.info('[AUTH] Token refresh requested')

    const { data, error } = await anonSupabase.auth.refreshSession({ refresh_token })

    if (error) {
      const mapped = mapAuthError(error.message)
      logger.warn('[AUTH] Token refresh failed', { code: mapped.code, raw: error.message })
      return res.status(mapped.status).json({ success: false, error: { code: mapped.code, message: mapped.message } })
    }

    logger.info('[AUTH] Token refreshed', { userId: data.user?.id })
    res.json({
      success: true,
      data: {
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at,
          expires_in: data.session.expires_in,
        }
      }
    })
  } catch (err) { next(err) }
})

// POST /auth/recover — send password reset email
router.post('/recover', async (req, res, next) => {
  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'Email is required.' }
      })
    }

    logger.info('[AUTH] Password recovery requested', { email: email.trim() })

    const { error } = await anonSupabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${process.env.FRONTEND_URL}/reset-password`
    })

    if (error) {
      const mapped = mapAuthError(error.message)
      logger.warn('[AUTH] Password recovery failed', { email: email.trim(), raw: error.message })
      return res.status(mapped.status).json({ success: false, error: { code: mapped.code, message: mapped.message } })
    }

    // Always return success to avoid exposing whether an email exists
    logger.info('[AUTH] Password recovery email sent (or email not found — not disclosed)', { email: email.trim() })
    res.json({ success: true, message: 'If an account with that email exists, a reset link has been sent.' })
  } catch (err) { next(err) }
})

// PUT /auth/password — update password for authenticated user
router.put('/password', requireAuth, async (req, res, next) => {
  try {
    const { password } = req.body

    if (!password) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'password is required.' }
      })
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 6 characters.' }
      })
    }

    logger.info('[AUTH] Password update requested', { userId: req.user.id })

    const { error } = await adminSupabase.auth.admin.updateUserById(req.user.id, { password })

    if (error) {
      const mapped = mapAuthError(error.message)
      logger.warn('[AUTH] Password update failed', { userId: req.user.id, raw: error.message })
      return res.status(mapped.status).json({ success: false, error: { code: mapped.code, message: mapped.message } })
    }

    logger.info('[AUTH] Password updated', { userId: req.user.id })
    res.json({ success: true, message: 'Password updated successfully.' })
  } catch (err) { next(err) }
})

// POST /auth/google — sign in / sign up via Google OAuth code exchange
router.post('/google', async (req, res, next) => {
  try {
    const { code, redirect_uri } = req.body

    if (!code || !redirect_uri) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'code and redirect_uri are required.' }
      })
    }

    logger.info('[AUTH] Google sign-in — exchanging code')

    // Exchange authorization code for tokens using client_secret
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri,
        grant_type: 'authorization_code',
      }).toString(),
    })

    const tokenData = await tokenRes.json()

    if (!tokenRes.ok) {
      logger.warn('[AUTH] Google code exchange failed', { error: tokenData.error, desc: tokenData.error_description })
      return res.status(401).json({
        success: false,
        error: { code: 'GOOGLE_FAILED', message: tokenData.error_description || 'Google sign-in failed.' }
      })
    }

    // Fetch user info using the access token
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })

    if (!userInfoRes.ok) {
      return res.status(401).json({
        success: false,
        error: { code: 'GOOGLE_FAILED', message: 'Failed to fetch Google user info.' }
      })
    }

    const userInfo = await userInfoRes.json()
    logger.info('[AUTH] Google user info fetched', { email: userInfo.email })

    // Find or create user in Supabase auth
    const { data: existingUsers } = await adminSupabase.auth.admin.listUsers()
    const existing = existingUsers?.users?.find(u => u.email === userInfo.email)

    let authUser, session

    if (existing) {
      const { data: sessionData, error: sessionError } = await adminSupabase.auth.admin.createSession(existing.id)
      if (sessionError) throw sessionError
      authUser = existing
      session = sessionData.session
    } else {
      const { data: newUser, error: createError } = await adminSupabase.auth.admin.createUser({
        email: userInfo.email,
        email_confirm: true,
        user_metadata: { full_name: userInfo.name, avatar_url: userInfo.picture },
      })
      if (createError) throw createError
      authUser = newUser.user
      const { data: sessionData, error: sessionError } = await adminSupabase.auth.admin.createSession(authUser.id)
      if (sessionError) throw sessionError
      session = sessionData.session
    }

    // Upsert profile row
    const { data: profile } = await adminSupabase
      .from('users')
      .upsert({
        id: authUser.id,
        full_name: userInfo.name,
        avatar_url: userInfo.picture,
      }, { onConflict: 'id' })
      .select()
      .single()

    logger.info('[AUTH] Google sign-in complete', { userId: authUser.id, isNew: !existing })
    res.json({
      success: true,
      data: {
        user: profile || authUser,
        session: {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_at: session.expires_at,
        },
        is_new_user: !existing,
      }
    })
  } catch (err) { next(err) }
})

// POST /auth/signout — invalidate Supabase session server-side
router.post('/signout', requireAuth, async (req, res, next) => {
  try {
    await adminSupabase.auth.admin.signOut(req.user.id)
    logger.info('[AUTH] User signed out', { userId: req.user.id })
    res.json({ success: true })
  } catch (err) { next(err) }
})

// POST /auth/push-token — save push notification token
router.post('/push-token', requireAuth, async (req, res, next) => {
  try {
    const { token } = req.body
    if (!token) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'token is required.' }
      })
    }

    await adminSupabase
      .from('users')
      .update({ notification_token: token })
      .eq('id', req.user.id)

    logger.info('[AUTH] Push token saved', { userId: req.user.id })
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
