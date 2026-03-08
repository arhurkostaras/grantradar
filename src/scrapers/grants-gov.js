// src/scrapers/grants-gov.js — Grants.gov USA Federal Grants Scraper
// API Docs: https://www.grants.gov/web/grants/xml-extract.html
// Search endpoint: GET https://www.grants.gov/grantsws/rest/opportunities/search/
// No auth required for basic search
const axios = require('axios');

const BASE_URL = 'https://www.grants.gov/grantsws/rest/opportunities/search/';
const DETAIL_URL = 'https://www.grants.gov/grantsws/rest/opportunity/details/';
const PAGE_SIZE = 25;
const DELAY_BETWEEN_REQUESTS = 2000;

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

// Map CFDA categories to sectors
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
      // Search for active and forecasted opportunities
      let pageNumber = 1;
      let hasMore = true;

      while (hasMore) {
        try {
          const response = await axios.get(BASE_URL, {
            params: {
              keyword: '',
              oppStatuses: 'forecasted|posted',
              sortBy: 'openDate|desc',
              rows: PAGE_SIZE,
              startRecordNum: (pageNumber - 1) * PAGE_SIZE,
            },
            timeout: 30000,
            headers: { 'User-Agent': 'GrantRadar/1.0 (grant-intelligence-platform)' },
          });

          const data = response.data;
          if (!data || !data.oppHits) {
            console.log('[Grants.gov] No oppHits in response, ending pagination');
            hasMore = false;
            break;
          }

          const opportunities = data.oppHits;
          this.stats.found += opportunities.length;
          console.log(`[Grants.gov] Page ${pageNumber}: ${opportunities.length} opportunities (total: ${this.stats.found})`);

          for (const opp of opportunities) {
            await this._processOpportunity(opp);
          }

          // Check if there are more pages
          if (opportunities.length < PAGE_SIZE || this.stats.found >= (data.hitCount || 0)) {
            hasMore = false;
          } else {
            pageNumber++;
            await this._delay(DELAY_BETWEEN_REQUESTS);
          }

          // Safety cap at 5000 grants per run
          if (this.stats.found >= 5000) {
            console.log('[Grants.gov] Safety cap reached (5000), stopping');
            hasMore = false;
          }
        } catch (err) {
          console.error(`[Grants.gov] Error on page ${pageNumber}:`, err.message);
          this.stats.errors++;
          if (this.stats.errors > 10) {
            console.error('[Grants.gov] Too many errors, stopping');
            hasMore = false;
          } else {
            await this._delay(5000);
            pageNumber++;
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
      const title = opp.title || opp.oppTitle || '';
      const agency = opp.agency || opp.agencyCode || '';
      const description = opp.synopsis || opp.description || '';
      const oppNumber = opp.number || opp.oppNumber || opp.id || '';

      // Parse dates
      const closeDate = opp.closeDate ? new Date(opp.closeDate) : null;
      const openDate = opp.openDate ? new Date(opp.openDate) : null;

      // Parse amounts
      const awardCeiling = parseFloat(opp.awardCeiling) || null;
      const awardFloor = parseFloat(opp.awardFloor) || null;

      // Map CFDA to sectors
      const cfdaNumber = opp.cfdaNumber || '';
      const cfdaPrefix = cfdaNumber.split('.')[0];
      const sectors = CFDA_SECTOR_MAP[cfdaPrefix] || ['general'];

      // Map eligibility
      const eligCodes = (opp.eligibilityCategories || '').split(',').map(s => s.trim());
      const eligibilityTypes = new Set();
      for (const code of eligCodes) {
        const mapped = ELIGIBILITY_MAP[code];
        if (mapped) mapped.forEach(e => eligibilityTypes.add(e));
      }
      if (eligibilityTypes.size === 0) eligibilityTypes.add('any');

      const applicationUrl = opp.oppId
        ? `https://www.grants.gov/search-results-detail/${opp.oppId}`
        : `https://www.grants.gov/search-results-detail/${oppNumber}`;

      const sourceUrl = applicationUrl;
      const isRolling = !closeDate;
      const status = closeDate && closeDate < new Date() ? 'expired' : 'active';

      // Determine grant status
      let grantStatus = 'active';
      if (closeDate && closeDate < new Date()) grantStatus = 'expired';
      else if (openDate && openDate > new Date()) grantStatus = 'upcoming';

      // Upsert grant
      const result = await this.pool.query(
        `INSERT INTO grants (title, description, funder_name, funder_type, country, funding_amount_min, funding_amount_max, currency, deadline, is_rolling, eligibility_types, sectors, keywords, application_url, source_url, source_system, last_verified, status)
         VALUES ($1, $2, $3, 'government', 'US', $4, $5, 'USD', $6, $7, $8::eligibility_type[], $9, $10, $11, $12, 'grants_gov', NOW(), $13::grant_status)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          title,
          description.substring(0, 5000),
          agency,
          awardFloor,
          awardCeiling,
          closeDate,
          isRolling,
          `{${[...eligibilityTypes].join(',')}}`,
          `{${sectors.map(s => `"${s}"`).join(',')}}`,
          `{${oppNumber ? `"${oppNumber}"` : ''}}`,
          applicationUrl,
          sourceUrl,
          grantStatus,
        ]
      );

      if (result.rows.length > 0) {
        this.stats.inserted++;
      } else {
        // Try update existing
        const updated = await this.pool.query(
          `UPDATE grants SET description = $1, funding_amount_min = $2, funding_amount_max = $3, deadline = $4, status = $5::grant_status, last_verified = NOW(), updated_at = NOW()
           WHERE source_system = 'grants_gov' AND title = $6 AND funder_name = $7
           RETURNING id`,
          [description.substring(0, 5000), awardFloor, awardCeiling, closeDate, grantStatus, title, agency]
        );
        if (updated.rows.length > 0) this.stats.updated++;
      }
    } catch (err) {
      console.error(`[Grants.gov] Error processing opportunity:`, err.message);
      this.stats.errors++;
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { GrantsGovScraper };
