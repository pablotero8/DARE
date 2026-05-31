import cron from 'node-cron';
import { sendMessage } from './whatsapp.js';
import { sendPasswordReset } from './mailer.js';
import { Resend } from 'resend';
import { listClients } from './clients.js';

const CLIENT_URL = process.env.APP_URL || 'https://dare-production-2636.up.railway.app';
const FROM = process.env.EMAIL_FROM || 'DARE <onboarding@resend.dev>';

function resendClient() {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
  return new Resend(process.env.RESEND_API_KEY);
}

// ── Welcome notifications ─────────────────────────────────────

export async function sendWelcomeWhatsApp(client, password) {
  if (!client.phone) return;
  const to = client.phone.startsWith('whatsapp:') ? client.phone : `whatsapp:${client.phone}`;
  const body =
    `👋 Welcome to DARE, ${client.name.split(' ')[0]}!\n\n` +
    `Your private health portal is ready:\n` +
    `🔗 ${CLIENT_URL}/client.html\n\n` +
    `📧 Email: ${client.email}\n` +
    `🔑 Password: ${password}\n\n` +
    `Log in to see your training and nutrition plan. Any questions, just ask your coach!`;
  await sendMessage(to, body);
}

export async function sendWelcomeEmail(client, password) {
  if (!client.email) return;
  const firstName = client.name.split(' ')[0];
  const resend = resendClient();
  const { error } = await resend.emails.send({
    from: FROM,
    to: client.email,
    subject: 'Welcome to DARE — Your portal is ready',
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#07070a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#07070a;padding:40px 20px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#0f0f12;border:1px solid rgba(244,241,232,.08);border-radius:16px;overflow:hidden">
        <tr><td style="padding:32px 36px 24px;border-bottom:1px solid rgba(244,241,232,.06)">
          <p style="margin:0;font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:rgba(201,162,74,.8);font-weight:700">DARE COACHING PLATFORM</p>
          <h1 style="margin:8px 0 0;font-size:28px;font-weight:800;color:#f4f1e8;letter-spacing:.02em">Welcome, ${firstName}!</h1>
        </td></tr>
        <tr><td style="padding:28px 36px">
          <p style="margin:0 0 20px;font-size:15px;color:rgba(244,241,232,.65);line-height:1.6">
            Your private health portal is ready. Here are your login credentials:
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(244,241,232,.04);border:1px solid rgba(244,241,232,.08);border-radius:10px;margin-bottom:24px">
            <tr><td style="padding:16px 20px">
              <p style="margin:0 0 8px;font-size:12px;color:rgba(244,241,232,.4);letter-spacing:.1em;text-transform:uppercase">Email</p>
              <p style="margin:0;font-size:15px;color:#f4f1e8;font-weight:600">${client.email}</p>
            </td></tr>
            <tr><td style="padding:0 20px 16px">
              <p style="margin:0 0 8px;font-size:12px;color:rgba(244,241,232,.4);letter-spacing:.1em;text-transform:uppercase">Password</p>
              <p style="margin:0;font-size:15px;color:#c9a24a;font-weight:700;letter-spacing:.05em">${password}</p>
            </td></tr>
          </table>
          <table cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:linear-gradient(135deg,#c9a24a,#a6c85e)">
            <a href="${CLIENT_URL}/client.html" style="display:inline-block;padding:14px 32px;font-size:14px;font-weight:700;color:#070707;text-decoration:none;letter-spacing:.05em">Access My Portal →</a>
          </td></tr></table>
          <p style="margin:24px 0 0;font-size:13px;color:rgba(244,241,232,.35);line-height:1.6">
            We recommend changing your password after first login.<br>
            Your training and nutrition plan will be updated here weekly.
          </p>
        </td></tr>
        <tr><td style="padding:20px 36px;border-top:1px solid rgba(244,241,232,.06)">
          <p style="margin:0;font-size:11px;color:rgba(244,241,232,.2)">DARE · Training & Nutrition Coaching</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
  if (error) throw new Error('Welcome email failed: ' + JSON.stringify(error));
}

export async function sendWelcomeNotifications(client, password) {
  const results = await Promise.allSettled([
    sendWelcomeWhatsApp(client, password),
    sendWelcomeEmail(client, password),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') console.error('[notifier] welcome error:', r.reason?.message);
  }
}

// ── Daily reminder ────────────────────────────────────────────

async function sendDailyReminders() {
  const clients = listClients().filter(c => c.role === 'client' && c.phone);
  console.log(`[notifier] sending daily reminders to ${clients.length} client(s)`);
  for (const c of clients) {
    try {
      const to = c.phone.startsWith('whatsapp:') ? c.phone : `whatsapp:${c.phone}`;
      const body =
        `💪 Hey ${c.name.split(' ')[0]}! Don't forget to log today's training and nutrition.\n\n` +
        `👉 ${CLIENT_URL}/client.html\n\n` +
        `Consistency is everything — keep it up! 🔥`;
      await sendMessage(to, body);
    } catch (err) {
      console.error(`[notifier] reminder failed for ${c.id}:`, err.message);
    }
  }
}

export function scheduleDailyReminders() {
  // Every day at 21:00 Madrid time
  cron.schedule('0 21 * * *', sendDailyReminders, { timezone: 'Europe/Madrid' });
  console.log('[notifier] daily reminders scheduled at 21:00 Europe/Madrid');
}
