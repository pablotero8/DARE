import { Resend } from 'resend';

const CLIENT_URL = process.env.APP_URL || 'https://darehabits.com';
const FROM = process.env.EMAIL_FROM || 'DARE <onboarding@resend.dev>';

function resendClient() {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
  return new Resend(process.env.RESEND_API_KEY);
}

// Diagnostic: send a plain test email and return the raw Resend response.
export async function sendTestEmail(to) {
  const resend = resendClient();
  const result = await resend.emails.send({
    from: FROM,
    to,
    subject: 'DARE test email',
    html: '<p>If you can read this, DARE email sending works ✅</p>',
  });
  return { from: FROM, to, ...result };
}

// Shared email shell — header + body + footer in DARE styling
function emailShell({ eyebrow, title, bodyHtml }) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#07070a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#07070a;padding:40px 20px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#0f0f12;border:1px solid rgba(244,241,232,.08);border-radius:16px;overflow:hidden">
        <tr><td style="padding:32px 36px 24px;border-bottom:1px solid rgba(244,241,232,.06)">
          <p style="margin:0;font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:rgba(201,162,74,.8);font-weight:700">${eyebrow}</p>
          <h1 style="margin:8px 0 0;font-size:28px;font-weight:800;color:#f4f1e8;letter-spacing:.02em">${title}</h1>
        </td></tr>
        <tr><td style="padding:28px 36px">${bodyHtml}</td></tr>
        <tr><td style="padding:20px 36px;border-top:1px solid rgba(244,241,232,.06)">
          <p style="margin:0;font-size:11px;color:rgba(244,241,232,.2)">DARE · Training & Nutrition Coaching</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function ctaButton(label, href) {
  return `<table cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:linear-gradient(135deg,#c9a24a,#a6c85e)">
    <a href="${href}" style="display:inline-block;padding:14px 32px;font-size:14px;font-weight:700;color:#070707;text-decoration:none;letter-spacing:.05em">${label}</a>
  </td></tr></table>`;
}

// ── Welcome email ─────────────────────────────────────────────

export async function sendWelcomeEmail(client, password) {
  if (!client.email) return;
  const firstName = client.name.split(' ')[0];
  const resend = resendClient();
  const bodyHtml = `
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
    ${ctaButton('Access My Portal →', `${CLIENT_URL}/client.html`)}
    <p style="margin:24px 0 0;font-size:13px;color:rgba(244,241,232,.35);line-height:1.6">
      We recommend changing your password after first login.<br>
      Your training and nutrition plan will be updated here weekly.
    </p>`;
  const { error } = await resend.emails.send({
    from: FROM,
    to: client.email,
    subject: 'Welcome to DARE — Your portal is ready',
    html: emailShell({ eyebrow: 'DARE COACHING PLATFORM', title: `Welcome, ${firstName}!`, bodyHtml }),
  });
  if (error) throw new Error('Welcome email failed: ' + JSON.stringify(error));
}

export async function sendWelcomeNotifications(client, password) {
  try {
    await sendWelcomeEmail(client, password);
  } catch (err) {
    console.error('[notifier] welcome error:', err.message);
  }
}

