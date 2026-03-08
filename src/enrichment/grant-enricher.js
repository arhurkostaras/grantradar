// src/enrichment/grant-enricher.js — Grant data enrichment for GrantRadar
// Crawls grant source websites to verify and enrich grant details
// Adapted from canadainvesting-backend FirmWebsiteEnricher pattern
const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('dns').promises;

const DAILY_LIMIT = 200;
const DELAY_BETWEEN_RECORDS = 1500;
const DELAY_BETWEEN_PAGES = 800;
const REQUEST_TIMEOUT = 8000;
const DNS_TIMEOUT = 3000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class GrantEnricher {
  constructor(pool) {
    this.pool = pool;
    this.running = false;
    this.stats = { attempted: 0, enriched: 0, failed: 0, expired: 0 };
  }

  async run() {
    if (this.running) {
      console.log('[GrantEnrich] Already running, skipping');
      return this.stats;
    }

    this.running = true;
    this.stats = { attempted: 0, enriched: 0, failed: 0, expired: 0 };
    console.log('[GrantEnrich] Starting grant enrichment run...');

    try {
      // Mark stale jobs as failed
      await this.pool.query(
        `UPDATE scrape_jobs SET status = 'failed', error_message = 'Stale job cleared', completed_at = NOW()
         WHERE source = 'grant_enrichment' AND status = 'running' AND started_at < NOW() - INTERVAL '2 hours'`
      );

      // Create job record
      const jobResult = await this.pool.query(
        `INSERT INTO scrape_jobs (source, status, started_at) VALUES ('grant_enrichment', 'running', NOW()) RETURNING id`
      );
      const jobId = jobResult.rows[0].id;

      // Priority 1: Verify grants with upcoming deadlines (within 30 days)
      const urgentGrants = await this.pool.query(
        `SELECT id, title, application_url, source_url, deadline, status
         FROM grants
         WHERE status = 'active'
           AND deadline IS NOT NULL
           AND deadline > NOW()
           AND deadline < NOW() + INTERVAL '30 days'
           AND last_verified < NOW() - INTERVAL '7 days'
         ORDER BY deadline ASC
         LIMIT $1`,
        [Math.floor(DAILY_LIMIT / 2)]
      );

      console.log(`[GrantEnrich] Priority 1 (urgent deadlines): ${urgentGrants.rows.length} grants`);

      for (const grant of urgentGrants.rows) {
        await this._verifyGrant(grant);
        this.stats.attempted++;
        if (this.stats.attempted % 10 === 0) {
          console.log(`[GrantEnrich] Progress: ${this.stats.attempted} attempted, ${this.stats.enriched} enriched, ${this.stats.expired} expired`);
        }
        await this._delay(DELAY_BETWEEN_RECORDS);
      }

      // Priority 2: Verify older grants that haven't been checked recently
      const remaining = DAILY_LIMIT - this.stats.attempted;
      if (remaining > 0) {
        const olderGrants = await this.pool.query(
          `SELECT id, title, application_url, source_url, deadline, status
           FROM grants
           WHERE status = 'active'
             AND last_verified < NOW() - INTERVAL '14 days'
           ORDER BY last_verified ASC
           LIMIT $1`,
          [remaining]
        );

        console.log(`[GrantEnrich] Priority 2 (stale verification): ${olderGrants.rows.length} grants`);

        for (const grant of olderGrants.rows) {
          await this._verifyGrant(grant);
          this.stats.attempted++;
          await this._delay(DELAY_BETWEEN_RECORDS);
        }
      }

      // Priority 3: Auto-expire past-deadline grants
      const expiredResult = await this.pool.query(
        `UPDATE grants SET status = 'expired', updated_at = NOW()
         WHERE status = 'active' AND deadline IS NOT NULL AND deadline < NOW() AND is_rolling = false
         RETURNING id`
      );
      this.stats.expired += expiredResult.rowCount;
      console.log(`[GrantEnrich] Auto-expired ${expiredResult.rowCount} past-deadline grants`);

      // Complete job
      await this.pool.query(
        `UPDATE scrape_jobs SET status = 'completed', records_found = $1, records_inserted = $2, records_updated = $3, completed_at = NOW() WHERE id = $4`,
        [this.stats.attempted, this.stats.enriched, this.stats.expired, jobId]
      );

      console.log(`[GrantEnrich] Complete — ${this.stats.attempted} attempted, ${this.stats.enriched} enriched, ${this.stats.expired} expired, ${this.stats.failed} failed`);
    } catch (err) {
      console.error('[GrantEnrich] Fatal error:', err.message);
    } finally {
      this.running = false;
    }

    return this.stats;
  }

  // -------------------------------------------------------------------------
  // Grant verification — check if the application URL is still live
  // -------------------------------------------------------------------------

  async _verifyGrant(grant) {
    try {
      const urlToCheck = grant.application_url || grant.source_url;
      if (!urlToCheck) {
        await this._markVerified(grant.id);
        this.stats.failed++;
        return;
      }

      const isLive = await this._checkUrlLive(urlToCheck);

      if (isLive) {
        // URL is live — try to enrich with additional data
        const pageData = await this._scrapeGrantPage(urlToCheck);

        if (pageData) {
          await this._updateGrantData(grant.id, pageData);
          this.stats.enriched++;
        } else {
          await this._markVerified(grant.id);
          this.stats.enriched++;
        }
      } else {
        // URL is dead — check if deadline has passed
        if (grant.deadline && new Date(grant.deadline) < new Date()) {
          await this.pool.query(
            `UPDATE grants SET status = 'expired', last_verified = NOW(), updated_at = NOW() WHERE id = $1`,
            [grant.id]
          );
          this.stats.expired++;
        } else {
          // URL dead but deadline not passed — might have moved
          await this._markVerified(grant.id);
          this.stats.failed++;
        }
      }
    } catch (err) {
      console.error(`[GrantEnrich] Error verifying grant ${grant.id}:`, err.message);
      await this._markVerified(grant.id);
      this.stats.failed++;
    }
  }

  async _checkUrlLive(url) {
    try {
      const domain = new URL(url).hostname;
      await Promise.race([
        dns.resolve4(domain),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), DNS_TIMEOUT))
      ]);

      const response = await axios.head(url, {
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': USER_AGENT },
        maxRedirects: 5,
        validateStatus: (status) => status < 500,
      });
      return response.status < 400;
    } catch (err) {
      // Try GET if HEAD fails
      try {
        const response = await axios.get(url, {
          timeout: REQUEST_TIMEOUT,
          headers: { 'User-Agent': USER_AGENT },
          maxRedirects: 5,
          validateStatus: (status) => status < 500,
        });
        return response.status < 400;
      } catch {
        return false;
      }
    }
  }

  async _scrapeGrantPage(url) {
    try {
      const response = await axios.get(url, {
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': USER_AGENT },
        maxRedirects: 5,
        validateStatus: (status) => status < 400,
      });

      if (typeof response.data !== 'string') return null;

      const $ = cheerio.load(response.data);
      const data = {};

      // Try to extract deadline from page
      const deadlinePatterns = [
        /deadline[:\s]*(\w+\s+\d{1,2},?\s+\d{4})/i,
        /closes?[:\s]*(\w+\s+\d{1,2},?\s+\d{4})/i,
        /due\s+date[:\s]*(\w+\s+\d{1,2},?\s+\d{4})/i,
        /applications?\s+due[:\s]*(\w+\s+\d{1,2},?\s+\d{4})/i,
      ];

      const text = $('body').text();
      for (const pattern of deadlinePatterns) {
        const match = text.match(pattern);
        if (match) {
          const parsed = new Date(match[1]);
          if (!isNaN(parsed.getTime())) {
            data.deadline = parsed;
            break;
          }
        }
      }

      // Try to extract funding amount
      const amountPatterns = [
        /(?:up\s+to|maximum|max)[:\s]*\$?([\d,]+(?:\.\d{2})?)\s*(?:million|M)?/i,
        /\$?([\d,]+(?:\.\d{2})?)\s*(?:million|M)?\s*(?:maximum|max|per\s+project)/i,
      ];

      for (const pattern of amountPatterns) {
        const match = text.match(pattern);
        if (match) {
          let amount = parseFloat(match[1].replace(/,/g, ''));
          if (/million|M/i.test(match[0])) amount *= 1000000;
          if (amount > 0) {
            data.funding_amount_max = amount;
            break;
          }
        }
      }

      // Extract description from meta tag if available
      const metaDesc = $('meta[name="description"]').attr('content');
      if (metaDesc && metaDesc.length > 50) {
        data.meta_description = metaDesc;
      }

      return Object.keys(data).length > 0 ? data : null;
    } catch (err) {
      return null;
    }
  }

  async _updateGrantData(grantId, data) {
    const updates = ['last_verified = NOW()', 'updated_at = NOW()'];
    const values = [];
    let paramIndex = 1;

    if (data.deadline) {
      updates.push(`deadline = $${paramIndex}`);
      values.push(data.deadline);
      paramIndex++;
    }

    if (data.funding_amount_max) {
      updates.push(`funding_amount_max = $${paramIndex}`);
      values.push(data.funding_amount_max);
      paramIndex++;
    }

    values.push(grantId);
    await this.pool.query(
      `UPDATE grants SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
  }

  async _markVerified(grantId) {
    await this.pool.query(
      `UPDATE grants SET last_verified = NOW(), updated_at = NOW() WHERE id = $1`,
      [grantId]
    );
  }

  // -------------------------------------------------------------------------
  // Rolling grant verification
  // -------------------------------------------------------------------------

  async verifyRollingGrants() {
    console.log('[GrantEnrich] Verifying rolling grants...');
    const rollingGrants = await this.pool.query(
      `SELECT id, title, application_url, source_url
       FROM grants
       WHERE is_rolling = true AND status = 'active'
         AND last_verified < NOW() - INTERVAL '30 days'
       ORDER BY last_verified ASC
       LIMIT 50`
    );

    let verified = 0;
    let expired = 0;

    for (const grant of rollingGrants.rows) {
      const url = grant.application_url || grant.source_url;
      if (!url) { await this._markVerified(grant.id); continue; }

      const isLive = await this._checkUrlLive(url);
      if (isLive) {
        await this._markVerified(grant.id);
        verified++;
      } else {
        await this.pool.query(
          `UPDATE grants SET status = 'expired', last_verified = NOW(), updated_at = NOW() WHERE id = $1`,
          [grant.id]
        );
        expired++;
      }
      await this._delay(DELAY_BETWEEN_RECORDS);
    }

    console.log(`[GrantEnrich] Rolling grants: ${verified} verified, ${expired} expired`);
    return { verified, expired };
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { GrantEnricher };
