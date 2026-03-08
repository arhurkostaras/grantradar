// src/monitoring/deadline-monitor.js — Grant Deadline Monitoring + Alert System
// Daily at 6am UTC: check grants expiring in 7, 14, 30 days
// Email alert to matched orgs with deadline warnings
// Auto-expire past-deadline grants
// Admin alert: new grants found in last 24h

const cron = require('node-cron');

class DeadlineMonitor {
  constructor(pool, emailService) {
    this.pool = pool;
    this.emailService = emailService;
    this.stats = { alerts_sent: 0, expired: 0, errors: 0 };
  }

  /**
   * Initialize cron jobs for deadline monitoring.
   */
  initialize() {
    // Daily at 6am UTC: deadline checks and alerts
    cron.schedule('0 6 * * *', async () => {
      console.log('[Monitor] Running daily deadline check...');
      try {
        await this.runDailyCheck();
      } catch (err) {
        console.error('[Monitor] Daily check error:', err.message);
      }
    });

    // Every 12 hours: auto-expire past-deadline grants
    cron.schedule('0 0,12 * * *', async () => {
      try {
        await this.autoExpireGrants();
      } catch (err) {
        console.error('[Monitor] Auto-expire error:', err.message);
      }
    });

    // Monthly 1st at 5am UTC: verify rolling grants still active
    cron.schedule('0 5 1 * *', async () => {
      try {
        await this.verifyRollingGrants();
      } catch (err) {
        console.error('[Monitor] Rolling grant verification error:', err.message);
      }
    });

    console.log('[Monitor] Deadline monitoring initialized — daily 6am UTC, auto-expire 0/12 UTC, rolling verification 1st monthly');
  }

  /**
   * Main daily check: find expiring grants, send alerts, send admin summary.
   */
  async runDailyCheck() {
    this.stats = { alerts_sent: 0, expired: 0, errors: 0 };

    // 1. Auto-expire past-deadline grants
    await this.autoExpireGrants();

    // 2. Find grants expiring in 7, 14, 30 days
    const urgentGrants = await this._getExpiringGrants(7);
    const soonGrants = await this._getExpiringGrants(14);
    const upcomingGrants = await this._getExpiringGrants(30);

    console.log(`[Monitor] Expiring grants — 7d: ${urgentGrants.length}, 14d: ${soonGrants.length}, 30d: ${upcomingGrants.length}`);

    // 3. Send alerts to matched organizations
    if (urgentGrants.length > 0) {
      await this._sendDeadlineAlerts(urgentGrants, 'urgent', 7);
    }
    if (soonGrants.length > 0) {
      await this._sendDeadlineAlerts(soonGrants, 'soon', 14);
    }
    // Only send 30-day alerts once per week (on Mondays)
    if (upcomingGrants.length > 0 && new Date().getDay() === 1) {
      await this._sendDeadlineAlerts(upcomingGrants, 'upcoming', 30);
    }

    // 4. Send admin summary
    await this._sendAdminSummary(urgentGrants, soonGrants, upcomingGrants);

    console.log(`[Monitor] Daily check complete — Alerts sent: ${this.stats.alerts_sent}, Expired: ${this.stats.expired}`);
    return this.stats;
  }

  /**
   * Auto-expire grants past their deadline.
   */
  async autoExpireGrants() {
    try {
      const result = await this.pool.query(
        `UPDATE grants SET status = 'expired', updated_at = NOW()
         WHERE status = 'active'
           AND deadline IS NOT NULL
           AND deadline < NOW()
           AND is_rolling = false
         RETURNING id, title`
      );

      this.stats.expired = result.rowCount;
      if (result.rowCount > 0) {
        console.log(`[Monitor] Auto-expired ${result.rowCount} past-deadline grants`);
      }

      return result.rowCount;
    } catch (err) {
      console.error('[Monitor] Auto-expire error:', err.message);
      this.stats.errors++;
      return 0;
    }
  }

  /**
   * Verify rolling grants are still active by checking their source URLs.
   */
  async verifyRollingGrants() {
    console.log('[Monitor] Verifying rolling grants...');
    try {
      // Just mark them as needing re-verification
      // The enrichment module handles actual URL checking
      const result = await this.pool.query(
        `SELECT COUNT(*) as count FROM grants
         WHERE is_rolling = true AND status = 'active'
           AND last_verified < NOW() - INTERVAL '30 days'`
      );

      const staleCount = parseInt(result.rows[0].count);
      console.log(`[Monitor] ${staleCount} rolling grants need re-verification`);

      return staleCount;
    } catch (err) {
      console.error('[Monitor] Rolling grant verification error:', err.message);
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  async _getExpiringGrants(withinDays) {
    try {
      const result = await this.pool.query(
        `SELECT id, title, funder_name, country, deadline, funding_amount_max, currency
         FROM grants
         WHERE status = 'active'
           AND deadline IS NOT NULL
           AND is_rolling = false
           AND deadline > NOW()
           AND deadline <= NOW() + INTERVAL '${withinDays} days'
         ORDER BY deadline ASC`
      );
      return result.rows;
    } catch (err) {
      console.error(`[Monitor] Error getting grants expiring in ${withinDays} days:`, err.message);
      return [];
    }
  }

  async _sendDeadlineAlerts(grants, urgency, days) {
    try {
      // For each grant, find matched organizations that haven't applied
      for (const grant of grants) {
        const matchedOrgs = await this.pool.query(
          `SELECT DISTINCT o.id, o.email, o.name, m.score
           FROM matches m
           JOIN organizations o ON m.org_id = o.id
           LEFT JOIN unsubscribes u ON u.email = o.email
           WHERE m.grant_id = $1
             AND m.applied = false
             AND m.score >= 0.4
             AND o.email IS NOT NULL
             AND o.email_verified = true
             AND u.id IS NULL
           ORDER BY m.score DESC
           LIMIT 50`,
          [grant.id]
        );

        if (matchedOrgs.rows.length === 0) continue;

        // Queue deadline alert emails
        const daysUntil = Math.ceil((new Date(grant.deadline) - new Date()) / (1000 * 60 * 60 * 24));
        const subject = urgency === 'urgent'
          ? `[Urgent] ${grant.title} — Only ${daysUntil} days left to apply`
          : `Grant Deadline Reminder: ${grant.title} — ${daysUntil} days remaining`;

        for (const org of matchedOrgs.rows) {
          try {
            await this.pool.query(
              `INSERT INTO email_queue (recipient_email, subject, html_body, status)
               VALUES ($1, $2, $3, 'pending')`,
              [
                org.email,
                subject,
                this._buildDeadlineAlertHtml(grant, org, daysUntil, urgency),
              ]
            );
            this.stats.alerts_sent++;
          } catch (err) {
            // Skip duplicate or invalid emails
            this.stats.errors++;
          }
        }
      }
    } catch (err) {
      console.error('[Monitor] Error sending deadline alerts:', err.message);
      this.stats.errors++;
    }
  }

  async _sendAdminSummary(urgent, soon, upcoming) {
    try {
      // Count new grants in last 24h
      const newGrantsResult = await this.pool.query(
        `SELECT COUNT(*) as count FROM grants WHERE created_at > NOW() - INTERVAL '24 hours'`
      );
      const newGrants = parseInt(newGrantsResult.rows[0].count);

      // Get total active grants
      const totalResult = await this.pool.query(
        `SELECT COUNT(*) as count FROM grants WHERE status = 'active'`
      );
      const totalActive = parseInt(totalResult.rows[0].count);

      const adminEmail = process.env.ADMIN_EMAIL || 'arthur@negotiateandwin.com';

      const subject = `[GrantRadar] Daily Summary — ${newGrants} new grants, ${urgent.length} urgent deadlines`;
      const html = `
        <h2>GrantRadar Daily Summary</h2>
        <p><strong>Date:</strong> ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
        <hr>
        <h3>Grant Database</h3>
        <ul>
          <li><strong>Total Active Grants:</strong> ${totalActive}</li>
          <li><strong>New Grants (24h):</strong> ${newGrants}</li>
          <li><strong>Expired Today:</strong> ${this.stats.expired}</li>
        </ul>
        <h3>Deadline Alerts</h3>
        <ul>
          <li><strong>Urgent (7 days):</strong> ${urgent.length} grants</li>
          <li><strong>Soon (14 days):</strong> ${soon.length} grants</li>
          <li><strong>Upcoming (30 days):</strong> ${upcoming.length} grants</li>
          <li><strong>Alerts Sent:</strong> ${this.stats.alerts_sent}</li>
        </ul>
        ${urgent.length > 0 ? `
        <h3>Urgent Deadlines</h3>
        <ul>
          ${urgent.map(g => {
            const days = Math.ceil((new Date(g.deadline) - new Date()) / (1000 * 60 * 60 * 24));
            return `<li>${g.title} (${g.funder_name}) — ${days} days (${g.currency || 'USD'} ${(g.funding_amount_max || 0).toLocaleString()})</li>`;
          }).join('')}
        </ul>` : ''}
      `;

      await this.pool.query(
        `INSERT INTO email_queue (recipient_email, subject, html_body, status) VALUES ($1, $2, $3, 'pending')`,
        [adminEmail, subject, html]
      );
    } catch (err) {
      console.error('[Monitor] Error sending admin summary:', err.message);
    }
  }

  _buildDeadlineAlertHtml(grant, org, daysUntil, urgency) {
    const urgencyColor = urgency === 'urgent' ? '#dc2626' : urgency === 'soon' ? '#f59e0b' : '#1A7A4A';
    const urgencyLabel = urgency === 'urgent' ? 'URGENT' : urgency === 'soon' ? 'UPCOMING' : 'REMINDER';

    const fundingStr = grant.funding_amount_max
      ? `${grant.currency || 'USD'} ${(grant.funding_amount_max).toLocaleString()}`
      : 'Contact funder';

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Tahoma,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;">
    <tr><td align="center" style="padding:40px 20px;">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.1);">
        <tr><td style="background:linear-gradient(135deg,#1A7A4A 0%,#0d5c35 100%);padding:24px 40px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:24px;">GrantRadar</h1>
          <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Deadline Alert</p>
        </td></tr>
        <tr><td style="padding:32px 40px;">
          <div style="display:inline-block;background:${urgencyColor};color:#fff;padding:4px 12px;border-radius:4px;font-size:12px;font-weight:700;margin-bottom:16px;">${urgencyLabel} — ${daysUntil} DAYS LEFT</div>
          <h2 style="margin:12px 0;color:#111;font-size:20px;">${grant.title}</h2>
          <table width="100%" style="margin:16px 0;border-collapse:collapse;">
            <tr><td style="padding:8px;color:#666;font-size:13px;border-bottom:1px solid #eee;">Funder</td><td style="padding:8px;color:#111;font-size:14px;border-bottom:1px solid #eee;font-weight:500;">${grant.funder_name}</td></tr>
            <tr><td style="padding:8px;color:#666;font-size:13px;border-bottom:1px solid #eee;">Funding</td><td style="padding:8px;color:#111;font-size:14px;border-bottom:1px solid #eee;font-weight:500;">Up to ${fundingStr}</td></tr>
            <tr><td style="padding:8px;color:#666;font-size:13px;border-bottom:1px solid #eee;">Deadline</td><td style="padding:8px;color:${urgencyColor};font-size:14px;border-bottom:1px solid #eee;font-weight:700;">${new Date(grant.deadline).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</td></tr>
            <tr><td style="padding:8px;color:#666;font-size:13px;">Match Score</td><td style="padding:8px;color:#1A7A4A;font-size:14px;font-weight:700;">${Math.round((org.score || 0) * 100)}%</td></tr>
          </table>
          <div style="text-align:center;margin:24px 0;">
            <a href="${process.env.FRONTEND_URL || 'https://grantradar.com'}/my-matches.html" style="display:inline-block;background:#1A7A4A;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">View Grant Details</a>
          </div>
          <p style="color:#666;font-size:13px;line-height:1.5;">Hi ${org.name}, this grant matched your profile and the deadline is approaching${urgency === 'urgent' ? ' quickly' : ''}. Don't miss this opportunity!</p>
        </td></tr>
        <tr><td style="padding:16px 40px;border-top:1px solid #eee;text-align:center;">
          <p style="margin:0;color:#999;font-size:11px;">&copy; ${new Date().getFullYear()} GrantRadar — Global Grant Intelligence</p>
          <p style="margin:4px 0 0;color:#999;font-size:11px;"><a href="${process.env.FRONTEND_URL || 'https://grantradar.com'}/unsubscribe" style="color:#999;">Unsubscribe</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }
}

module.exports = { DeadlineMonitor };
