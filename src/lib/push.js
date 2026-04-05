const { Expo } = require('expo-server-sdk')
const { adminSupabase } = require('./supabase')

const expo = new Expo()

async function sendPush(userId, title, body, data = {}) {
  const { data: user } = await adminSupabase
    .from('users')
    .select('notification_token, notification_enabled')
    .eq('id', userId)
    .single()

  if (!user || !user.notification_enabled || !user.notification_token) return
  if (!Expo.isExpoPushToken(user.notification_token)) return

  const messages = [{
    to: user.notification_token,
    sound: 'default',
    title,
    body,
    data
  }]

  try {
    await expo.sendPushNotificationsAsync(messages)
  } catch (err) {
    console.error('[PUSH] Failed to send notification:', err.message)
  }

  await adminSupabase.from('notifications').insert({
    user_id: userId,
    type: data.type || 'push',
    title,
    body,
    data
  })
}

module.exports = { sendPush }
