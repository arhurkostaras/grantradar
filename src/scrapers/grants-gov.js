// src/scrapers/grants-gov.js — Grants.gov USA Federal Grants Scraper
// New API (March 2025): POST https://api.grants.gov/v1/api/search2
// Detail: POST https://api.grants.gov/v1/api/fetchOpportunity
// No auth required
const axios = require('axios');

const SEARCH_URL = 'https://api.grants.gov/v1/api/search2';
const DETAIL_URL = 'https://api.grants.gov/v1/api/fetchOpportunity';
const PAGE_SIZE = 100;
const DELAY_BETWEEN_REQUESTS = 2000;
const DETAIL_DELAY = 500;
const MAX_GRANTS = 3000;

// Map Grants.gov eligibility codes to our eligibility_types
const ELIGIBILITY_MAP = {
  '00': ['any'],           // Unrestricted
  '01': ['sme'],           // Small businesses
  '02': ['nonprofit'],     // Nonprofits with 501(c)(3)
  '04': ['research'],      // Public/State institutions of higher education
  '05': ['research'],      // Private institutions of higher education
  '06': ['indigenous'],    // Native American tribal governments
  '07': ['indigenous'],    // Native American tribal organizations
  '11': ['any'],           // Other
  '12': ['nonprofit'],     // Nonprofits without 501(c)(3)
  '20': ['research'],      // Public/Indian housing authorities
  '21': ['sme'],           // Individuals
  '22': ['sme', 'startup'], // For-profit organizations
  '25': ['any'],           // Others
  '99': ['any'],           // Unrestricted
};

// Map CFDA category prefixes to sectors
const CFDA_SECTOR_MAP = {
  '10': ['agriculture', 'food'],
  '11': ['technology', 'manufacturing'],
  '12': ['defense'],
  '14': ['housing', 'community'],
  '15': ['environment', 'natural-resources'],
  '16': ['social-impact', 'justice'],
  '17': ['workforce', 'training'],
  '19': ['international'],
  '20': ['transportation'],
  '43': ['technology', 'aerospace'],
  '47': ['research', 'science'],
  '59': ['sme-support'],
  '66': ['environment', 'clean-energy'],
  '81': ['clean-energy', 'nuclear'],
  '84': ['education'],
  '93': ['healthcare'],
};

class GrantsGovScraper {
  constructor(pool) {
    this.pool = pool;
    this.stats = { found: 0, inserted: 0, updated: 0, errors: 0 };
  }

  async scrape() {
    console.log('[Grants.gov] Starting scrape...');
    this.stats = { found: 0, inserted: 0, updated: 0, errors: 0 };

    // Create job record
    const jobResult = await this.pool.query(
      `INSERT INTO scrape_jobs (source, country, status, started_at) VALUES ('grants_gov', 'US', 'running', NOW()) RETURNING id`
    );
    const jobId = jobResult.rows[0].id;

    try {
      // Search for posted and forecasted opportunities
      let startRecord = 0;
      let hasMore = true;
      let consecutiveErrors = 0;

      while (hasMore) {
        try {
          const response = await axios.post(SEARCH_URL, {
            keyword: '',
            oppStatuses: 'posted|forecasted',
            rows: PAGE_SIZE,
            startRecordNum: startRecord,
          }, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' },
          });

          const data = response.data;
          if (!data || !data.data || !data.data.oppHits) {
            console.log('[Grants.gov] No oppHits in response, ending pagination');
            hasMore = false;
            break;
          }

          const opportunities = data.data.oppHits;
          const hitCount = data.data.hitCount || 0;
          this.stats.found += opportunities.length;
          consecutiveErrors = 0;

          const page = Math.floor(startRecord / PAGE_SIZE) + 1;
          console.log(`[Grants.gov] Page ${page}: ${opportunities.length} opportunities (total: ${this.stats.found}/${hitCount})`);

          for (const opp of opportunities) {
            await this._processOpportunity(opp);
          }

          // Check if there are more pages
          if (opportunities.length < PAGE_SIZE || this.stats.found >= hitCount) {
            hasMore = false;
          } else {
            startRecord += PAGE_SIZE;
            await this._delay(DELAY_BETWEEN_REQUESTS);
          }

          // Safety cap
          if (this.stats.found >= MAX_GRANTS) {
            console.log(`[Grants.gov] Safety cap reached (${MAX_GRANTS}), stopping`);
            hasMore = false;
          }
        } catch (err) {
          const page = Math.floor(startRecord / PAGE_SIZE) + 1;
          console.error(`[Grants.gov] Error on page ${page}:`, err.message);
          this.stats.errors++;
          consecutiveErrors++;
          if (consecutiveErrors > 5) {
            console.error('[Grants.gov] Too many consecutive errors, stopping');
            hasMore = false;
          } else {
            await this._delay(5000);
            startRecord += PAGE_SIZE;
          }
        }
      }

      // Complete job
      await this.pool.query(
        `UPDATE scrape_jobs SET status = 'completed', records_found = $1, records_inserted = $2, records_updated = $3, completed_at = NOW() WHERE id = $4`,
        [this.stats.found, this.stats.inserted, this.stats.updated, jobId]
      );

      console.log(`[Grants.gov] Complete — Found: ${this.stats.found}, Inserted: ${this.stats.inserted}, Updated: ${this.stats.updated}, Errors: ${this.stats.errors}`);
    } catch (err) {
      console.error('[Grants.gov] Fatal error:', err.message);
      await this.pool.query(
        `UPDATE scrape_jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
        [err.message, jobId]
      );
    }

    return this.stats;
  }

  async _processOpportunity(opp) {
    try {
      const title = opp.title || '';
      const agency = opp.agency || opp.agencyCode || '';
      const oppNumber = opp.number || opp.id || '';
      const oppId = opp.id || '';

      // Parse dates — format is MM/DD/YYYY
      const closeDate = opp.closeDate ? this._parseDate(opp.closeDate) : null;
      const openDate = opp.openDate ? this._parseDate(opp.openDate) : null;

      // Map CFDA to sectors from cfdaList array
      const cfdaList = opp.cfdaList || [];
      const sectors = new Set();
      for (const cfda of cfdaList) {
        const prefix = String(cfda).split('.')[0];
        const mapped = CFDA_SECTOR_MAP[prefix];
        if (mapped) mapped.forEach(s => sectors.add(s));
      }
      if (sectors.size === 0) sectors.add('general');

      // search2 doesn't return eligibility or award amounts — use defaults
      // We'll fetch details for a subset of high-value grants later
      const eligibilityTypes = new Set(['any']);
      const awardCeiling = null;
      const awardFloor = null;

      const applicationUrl = `https://www.grants.gov/search-results-detail/${oppId}`;
      const isRolling = !closeDate;

      let grantStatus = 'active';
      if (closeDate && closeDate < new Date()) grantStatus = 'expired';
      else if (openDate && openDate > new Date()) grantStatus = 'upcoming';

      // Determine oppStatus
      if (opp.oppStatus === 'forecasted') grantStatus = 'upcoming';

      // Upsert grant
      const result = await this.pool.query(
        `INSERT INTO grants (title, funder_name, funder_type, country, funding_amount_min, funding_amount_max, currency, deadline, is_rolling, eligibility_types, sectors, keywords, application_url, source_url, source_system, last_verified, status)
         VALUES ($1, $2, 'government', 'US', $3, $4, 'USD', $5, $6, $7::eligibility_type[], $8, $9, $10, $11, 'grants_gov', NOW(), $12::grant_status)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          title,
          agency,
          awardFloor,
          awardCeiling,
          closeDate,
          isRolling,
          `{${[...eligibilityTypes].join(',')}}`,
          `{${[...sectors].map(s => `"${s}"`).join(',')}}`,
          `{${oppNumber ? `"${oppNumber}"` : ''}}`,
          applicationUrl,
          applicationUrl,
          grantStatus,
        ]
      );

      if (result.rows.length > 0) {
        this.stats.inserted++;
      } else {
        // Try update existing by title + source
        const updated = await this.pool.query(
          `UPDATE grants SET deadline = $1, status = $2::grant_status, last_verified = NOW(), updated_at = NOW()
           WHERE source_system = 'grants_gov' AND title = $3 AND funder_name = $4
           RETURNING id`,
          [closeDate, grantStatus, title, agency]
        );
        if (updated.rows.length > 0) this.stats.updated++;
      }
    } catch (err) {
      console.error(`[Grants.gov] Error processing opportunity:`, err.message);
      this.stats.errors++;
    }
  }

  /**
   * Enrich a batch of grants_gov grants with full details (award amounts, eligibility, description).
   * Called separately from scrape() to avoid rate limits during bulk ingestion.
   */
  async enrichDetails(limit = 50) {
    console.log(`[Grants.gov] Enriching up to ${limit} grants with full details...`);
    let enriched = 0;

    const grants = await this.pool.query(
      `SELECT id, application_url FROM grants
       WHERE source_system = 'grants_gov' AND description IS NULL
       ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );

    for (const grant of grants.rows) {
      try {
        // Extract opportunity ID from URL
        const urlParts = grant.application_url.split('/');
        const oppId = parseInt(urlParts[urlParts.length - 1]);
        if (!oppId || isNaN(oppId)) continue;

        const response = await axios.post(DETAIL_URL, {
          opportunityId: oppId,
        }, {
          timeout: 15000,
          headers: { 'Content-Type': 'application/json' },
        });

        const detail = response.data?.data;
        if (!detail || !detail.synopsis) continue;

        const syn = detail.synopsis;

        // Parse award amounts
        let awardCeiling = null;
        let awardFloor = null;
        if (syn.awardCeiling && syn.awardCeiling !== 'none') {
          awardCeiling = parseFloat(syn.awardCeiling.replace(/[,$]/g, '')) || null;
        }
        if (syn.awardFloor && syn.awardFloor !== 'none') {
          awardFloor = parseFloat(syn.awardFloor.replace(/[,$]/g, '')) || null;
        }

        // Parse eligibility from applicantTypes
        const eligibilityTypes = new Set();
        if (syn.applicantTypes) {
          for (const at of syn.applicantTypes) {
            const mapped = ELIGIBILITY_MAP[at.id];
            if (mapped) mapped.forEach(e => eligibilityTypes.add(e));
          }
        }
        if (eligibilityTypes.size === 0) eligibilityTypes.add('any');

        // Strip HTML from synopsis description
        const description = (syn.synopsisDesc || '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 5000);

        await this.pool.query(
          `UPDATE grants SET description = $1, funding_amount_min = $2, funding_amount_max = $3, eligibility_types = $4::eligibility_type[], updated_at = NOW()
           WHERE id = $5`,
          [
            description,
            awardFloor,
            awardCeiling,
            `{${[...eligibilityTypes].join(',')}}`,
            grant.id,
          ]
        );

        enriched++;
        await this._delay(DETAIL_DELAY);
      } catch (err) {
        console.error(`[Grants.gov] Enrich error for grant ${grant.id}:`, err.message);
      }
    }

    console.log(`[Grants.gov] Enriched ${enriched}/${grants.rows.length} grants`);
    return enriched;
  }

  _parseDate(dateStr) {
    if (!dateStr) return null;
    // Grants.gov returns MM/DD/YYYY
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      return new Date(`${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`);
    }
    // Fallback
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { GrantsGovScraper };
