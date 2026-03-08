// services/email.js — Resend email integration for GrantRadar
const { Resend } = require('resend');

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@grantradar.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'arthur@negotiateandwin.com';
const SITE_URL = process.env.FRONTEND_URL || 'https://grantradar.com';

let resend = null;

function getResendClient() {
  if (!resend && process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

// ---------------------------------------------------------------------------
// Shared HTML helpers — GrantRadar branding
// ---------------------------------------------------------------------------

function baseLayout(title, bodyContent) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:#0f1a14;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f1a14;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#1a2e22;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(26,122,74,0.15);">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1A7A4A 0%,#0d5c35 100%);padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:700;letter-spacing:-0.5px;">GrantRadar</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">Global Grant Intelligence</p>
              <p style="margin:4px 0 0;color:rgba(201,162,39,0.9);font-size:12px;">${title}</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              ${bodyContent}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px;border-top:1px solid rgba(255,255,255,0.08);text-align:center;">
              <p style="margin:0;color:rgba(255,255,255,0.4);font-size:12px;">
                &copy; ${new Date().getFullYear()} GrantRadar &mdash; Global Grant Intelligence
              </p>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.3);font-size:11px;">
                <a href="${SITE_URL}/unsubscribe" style="color:rgba(255,255,255,0.4);text-decoration:underline;">Unsubscribe</a>
                &nbsp;&middot;&nbsp;
                <a href="${SITE_URL}/privacy" style="color:rgba(255,255,255,0.4);text-decoration:underline;">Privacy Policy</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function heading(text) {
  return `<h2 style="margin:0 0 16px;color:#ffffff;font-size:22px;font-weight:600;">${text}</h2>`;
}

function paragraph(text) {
  return `<p style="margin:0 0 16px;color:rgba(255,255,255,0.75);font-size:15px;line-height:1.6;">${text}</p>`;
}

function detailRow(label, value) {
  return `<tr>
    <td style="padding:8px 12px;color:rgba(255,255,255,0.5);font-size:13px;border-bottom:1px solid rgba(255,255,255,0.06);width:160px;">${label}</td>
    <td style="padding:8px 12px;color:#ffffff;font-size:14px;border-bottom:1px solid rgba(255,255,255,0.06);font-weight:500;">${value || 'N/A'}</td>
  </tr>`;
}

function detailsTable(rows) {
  const inner = rows.map(([l, v]) => detailRow(l, v)).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:rgba(255,255,255,0.03);border-radius:8px;overflow:hidden;margin:0 0 24px;">
    ${inner}
  </table>`;
}

function ctaButton(text, url) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr>
      <td style="background:linear-gradient(135deg,#1A7A4A 0%,#0d5c35 100%);border-radius:8px;padding:14px 32px;">
        <a href="${url}" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;display:inline-block;">${text}</a>
      </td>
    </tr>
  </table>`;
}

function goldAccent(text) {
  return `<span style="color:#C9A227;font-weight:600;">${text}</span>`;
}

function divider() {
  return `<hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:24px 0;">`;
}

// ---------------------------------------------------------------------------
// 1. Core send function
// ---------------------------------------------------------------------------

async function sendEmail({ to, subject, html }) {
  const client = getResendClient();
  if (!client) {
    console.log(`[Email] RESEND_API_KEY not configured. Would have sent "${subject}" to ${to}`);
    return null;
  }
  try {
    const { data, error } = await client.emails.send({
      from: FROM_EMAIL,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    });

    if (error) {
      console.error(`[Email] Resend API error for ${to}:`, error);
      return { success: false, reason: 'api_error', error };
    }

    console.log(`[Email] Sent to ${to}: "${subject}" (id: ${data?.id || 'unknown'})`);
    return { success: true, id: data?.id || null };
  } catch (err) {
    console.error(`[Email] Failed to send "${subject}" to ${to}:`, err.message);
    return { success: false, reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// 2. Verification email
// ---------------------------------------------------------------------------

async function sendVerificationEmail(email, token) {
  const verifyUrl = `${SITE_URL}/verify-email?token=${token}`;
  const body = [
    heading('Verify Your Email'),
    paragraph('Welcome to GrantRadar! Please verify your email address to complete your registration.'),
    paragraph('Click the button below to verify your account:'),
    ctaButton('Verify Email', verifyUrl),
    divider(),
    paragraph('If you did not create an account on GrantRadar, you can safely ignore this email.'),
    paragraph(`<span style="color:rgba(255,255,255,0.4);font-size:12px;">If the button does not work, copy and paste this URL into your browser:<br><a href="${verifyUrl}" style="color:#1A7A4A;font-size:12px;word-break:break-all;">${verifyUrl}</a></span>`),
  ].join('');

  const html = baseLayout('Email Verification', body);
  await sendEmail({ to: email, subject: 'Verify Your Email - GrantRadar', html });
}

// ---------------------------------------------------------------------------
// 3. Password reset email
// ---------------------------------------------------------------------------

async function sendPasswordResetEmail(email, token) {
  const resetUrl = `${SITE_URL}/reset-password?token=${token}`;
  const body = [
    heading('Password Reset Request'),
    paragraph('We received a request to reset your GrantRadar password.'),
    paragraph('Click the button below to set a new password. This link will expire in <strong style="color:#ffffff;">1 hour</strong>.'),
    ctaButton('Reset Password', resetUrl),
    divider(),
    paragraph('If you did not request this password reset, you can safely ignore this email. Your password will remain unchanged.'),
    paragraph(`<span style="color:rgba(255,255,255,0.4);font-size:12px;">If the button does not work, copy and paste this URL into your browser:<br><a href="${resetUrl}" style="color:#1A7A4A;font-size:12px;word-break:break-all;">${resetUrl}</a></span>`),
  ].join('');

  const html = baseLayout('Password Reset', body);
  await sendEmail({ to: email, subject: 'Reset Your Password - GrantRadar', html });
}

// ---------------------------------------------------------------------------
// 4. Match digest — new top matches notification
// ---------------------------------------------------------------------------

async function sendMatchDigest(email, matches) {
  const topMatches = (matches || []).slice(0, 5);

  const matchRows = topMatches.map((m, i) => {
    const score = typeof m.score === 'number' ? `${Math.round(m.score * 100)}%` : m.score;
    const amount = m.funding_amount_max
      ? `Up to $${Number(m.funding_amount_max).toLocaleString()}`
      : 'Varies';
    const deadline = m.deadline
      ? new Date(m.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : (m.is_rolling ? 'Rolling' : 'N/A');
    return `<tr>
      <td style="padding:12px;border-bottom:1px solid rgba(255,255,255,0.06);">
        <strong style="color:#ffffff;font-size:14px;">#${i + 1} &mdash; ${m.title || 'Grant Opportunity'}</strong><br>
        <span style="color:rgba(255,255,255,0.5);font-size:12px;">${m.funder_name || ''} &middot; ${m.country || ''}</span><br>
        <span style="color:rgba(201,162,39,0.8);font-size:12px;">${amount} &middot; Deadline: ${deadline}</span>
      </td>
      <td style="padding:12px;border-bottom:1px solid rgba(255,255,255,0.06);text-align:right;vertical-align:top;">
        <span style="background:linear-gradient(135deg,#1A7A4A 0%,#0d5c35 100%);color:#fff;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:600;">${score}</span>
      </td>
    </tr>`;
  }).join('');

  const body = [
    heading('New Grant Matches Found'),
    paragraph(`We have identified ${goldAccent(topMatches.length + ' new grant' + (topMatches.length === 1 ? '' : 's'))} that match your organization profile.`),
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:rgba(255,255,255,0.03);border-radius:8px;overflow:hidden;margin:0 0 24px;">
      ${matchRows}
    </table>`,
    divider(),
    paragraph('Log in to your dashboard to see full details, eligibility criteria, and application links.'),
    ctaButton('View All Matches', `${SITE_URL}/dashboard/matches`),
    paragraph('<span style="color:rgba(255,255,255,0.4);font-size:12px;">You are receiving this because you opted into match notifications on GrantRadar.</span>'),
  ].join('');

  const html = baseLayout('New Grant Matches', body);
  await sendEmail({ to: email, subject: `${topMatches.length} New Grant Match${topMatches.length === 1 ? '' : 'es'} - GrantRadar`, html });
}

// ---------------------------------------------------------------------------
// 5. Deadline alert — deadline warning email
// ---------------------------------------------------------------------------

async function sendDeadlineAlert(email, grants) {
  const grantList = (grants || []).slice(0, 10);

  const grantRows = grantList.map((g) => {
    const deadline = g.deadline
      ? new Date(g.deadline).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
      : 'N/A';
    const daysLeft = g.deadline
      ? Math.ceil((new Date(g.deadline) - new Date()) / (1000 * 60 * 60 * 24))
      : null;
    const urgencyColor = daysLeft !== null && daysLeft <= 7 ? '#ef4444' : (daysLeft !== null && daysLeft <= 14 ? '#f59e0b' : '#10b981');
    return `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.06);">
        <strong style="color:#ffffff;font-size:14px;">${g.title || 'Grant Opportunity'}</strong><br>
        <span style="color:rgba(255,255,255,0.5);font-size:12px;">${g.funder_name || ''} &middot; ${g.country || ''}</span>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.06);text-align:right;vertical-align:top;">
        <span style="color:${urgencyColor};font-weight:600;font-size:13px;">${deadline}</span><br>
        ${daysLeft !== null ? `<span style="color:${urgencyColor};font-size:11px;">${daysLeft} day${daysLeft === 1 ? '' : 's'} left</span>` : ''}
      </td>
    </tr>`;
  }).join('');

  const body = [
    heading('Upcoming Grant Deadlines'),
    paragraph(`You have ${goldAccent(grantList.length + ' grant' + (grantList.length === 1 ? '' : 's'))} with approaching deadlines. Don't miss out on these funding opportunities.`),
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:rgba(255,255,255,0.03);border-radius:8px;overflow:hidden;margin:0 0 24px;">
      ${grantRows}
    </table>`,
    divider(),
    paragraph('Review your matched grants and start your applications before the deadlines pass.'),
    ctaButton('View Deadlines', `${SITE_URL}/dashboard/deadlines`),
  ].join('');

  const html = baseLayout('Deadline Alert', body);
  await sendEmail({ to: email, subject: `Deadline Alert: ${grantList.length} Grant${grantList.length === 1 ? '' : 's'} Closing Soon - GrantRadar`, html });
}

// ---------------------------------------------------------------------------
// 6. Admin alert — admin notification
// ---------------------------------------------------------------------------

async function sendAdminAlert(subject, alertBody) {
  const body = [
    heading('Admin Alert'),
    paragraph(alertBody),
    divider(),
    paragraph(`<span style="color:rgba(255,255,255,0.4);font-size:12px;">This is an automated admin notification from GrantRadar.</span>`),
  ].join('');

  const html = baseLayout('Admin Alert', body);
  await sendEmail({ to: ADMIN_EMAIL, subject: `[Admin] ${subject}`, html });
}

// ---------------------------------------------------------------------------
// 7. Contact form email
// ---------------------------------------------------------------------------

async function sendContactFormEmail({ name, email, company, subject, message }) {
  // Admin email with full details
  const adminBody = [
    heading('New Contact Form Submission'),
    detailsTable([
      ['Name', name],
      ['Email', email],
      ['Company', company || 'Not provided'],
      ['Subject', subject || 'General Inquiry'],
    ]),
    heading('Message'),
    `<div style="background-color:rgba(255,255,255,0.03);border-radius:8px;padding:16px;margin:0 0 24px;">
      <p style="margin:0;color:rgba(255,255,255,0.8);font-size:14px;line-height:1.7;white-space:pre-wrap;">${(message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
    </div>`,
    paragraph(`Reply directly to <a href="mailto:${email}" style="color:#1A7A4A;text-decoration:none;">${email}</a> to respond.`),
  ].join('');

  const adminHtml = baseLayout('Contact Form Submission', adminBody);
  await sendEmail({ to: ADMIN_EMAIL, subject: `[Contact] ${subject || 'General Inquiry'} from ${name}`, html: adminHtml });

  // Auto-reply to user
  const userBody = [
    heading(`Thank you for reaching out, ${name || 'there'}!`),
    paragraph('We have received your message and our team will get back to you within <strong style="color:#ffffff;">1 business day</strong>.'),
    paragraph('In the meantime, feel free to explore our grant database:'),
    ctaButton('Explore GrantRadar', SITE_URL),
    divider(),
    paragraph('<strong style="color:rgba(255,255,255,0.5);">Your message:</strong>'),
    `<div style="background-color:rgba(255,255,255,0.03);border-radius:8px;padding:16px;margin:0 0 16px;">
      <p style="margin:0;color:rgba(255,255,255,0.6);font-size:13px;line-height:1.6;white-space:pre-wrap;">${(message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
    </div>`,
    paragraph('Please do not reply to this automated confirmation.'),
  ].join('');

  const userHtml = baseLayout('We Received Your Message', userBody);
  await sendEmail({ to: email, subject: 'We received your message - GrantRadar', html: userHtml });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getResendClient,
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendMatchDigest,
  sendDeadlineAlert,
  sendAdminAlert,
  sendContactFormEmail,
};
