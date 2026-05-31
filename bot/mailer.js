import { Resend } from 'resend';

const FROM = process.env.EMAIL_FROM || 'DARE <onboarding@resend.dev>';

export async function sendPasswordReset(toEmail, toName, resetUrl) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const firstName = toName?.split(' ')[0] || 'there';
  const { error } = await resend.emails.send({
    from:    FROM,
    to:      toEmail,
    subject: 'Reset your DARE password',
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#07070a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#07070a;padding:40px 20px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#0f0f12;border:1px solid rgba(244,241,232,.08);border-radius:16px;overflow:hidden">
        <!-- Header -->
        <tr><td style="padding:32px 36px 24px;border-bottom:1px solid rgba(244,241,232,.06)">
          <p style="margin:0;font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:rgba(201,162,74,.8);font-weight:700">DARE COACHING PLATFORM</p>
          <h1 style="margin:8px 0 0;font-size:28px;font-weight:800;color:#f4f1e8;letter-spacing:.02em">Reset your password</h1>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:28px 36px">
          <p style="margin:0 0 20px;font-size:15px;color:rgba(244,241,232,.65);line-height:1.6">
            Hi <strong style="color:#f4f1e8">${firstName}</strong>,
          </p>
          <p style="margin:0 0 28px;font-size:15px;color:rgba(244,241,232,.65);line-height:1.6">
            We received a request to reset your DARE password. Click the button below — the link is valid for <strong style="color:#f4f1e8">15 minutes</strong>.
          </p>
          <table cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:linear-gradient(135deg,#c9a24a,#a6c85e)">
            <a href="${resetUrl}" style="display:inline-block;padding:14px 32px;font-size:14px;font-weight:700;color:#070707;text-decoration:none;letter-spacing:.05em">Reset Password →</a>
          </td></tr></table>
          <p style="margin:24px 0 0;font-size:12px;color:rgba(244,241,232,.3);line-height:1.6">
            If you didn't request this, ignore this email — your password won't change.<br>
            Or copy this link: <a href="${resetUrl}" style="color:rgba(201,162,74,.7)">${resetUrl}</a>
          </p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:20px 36px;border-top:1px solid rgba(244,241,232,.06)">
          <p style="margin:0;font-size:11px;color:rgba(244,241,232,.2)">DARE · Training & Nutrition Coaching</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
  if (error) throw new Error('Email send failed: ' + JSON.stringify(error));
}
