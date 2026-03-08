// src/scrapers/eu.js — European Union Grants Scraper
// EU Funding & Tenders Portal API: https://api.tech.ec.europa.eu/search-api/prod/rest/search
// No auth required. Free public API.
const axios = require('axios');

const API_BASE = 'https://api.tech.ec.europa.eu/search-api/prod/rest/search';
const PAGE_SIZE = 100;
const DELAY = 2000;

class EUGrantsScraper {
  constructor(pool) {
    this.pool = pool;
    this.stats = { found: 0, inserted: 0, updated: 0, errors: 0 };
  }

  async scrape() {
    console.log('[EU] Starting grants scrape...');
    this.stats = { found: 0, inserted: 0, updated: 0, errors: 0 };

    const jobResult = await this.pool.query(
      `INSERT INTO scrape_jobs (source, country, status, started_at) VALUES ('eu', 'EU', 'running', NOW()) RETURNING id`
    );
    const jobId = jobResult.rows[0].id;

    try {
      // Search for SME, startup, and research funding
      const searchTerms = ['SME', 'startup', 'innovation', 'research', 'green', 'digital', 'health', 'agriculture', 'energy'];

      for (const term of searchTerms) {
        await this._searchEUPortal(term);
        await this._delay(DELAY);
      }

      // Also scrape Horizon Europe programs
      await this._scrapeHorizonEurope();

      // Add curated EU programs
      await this._addCuratedEUPrograms();

      await this.pool.query(
        `UPDATE scrape_jobs SET status = 'completed', records_found = $1, records_inserted = $2, records_updated = $3, completed_at = NOW() WHERE id = $4`,
        [this.stats.found, this.stats.inserted, this.stats.updated, jobId]
      );

      console.log(`[EU] Complete — Found: ${this.stats.found}, Inserted: ${this.stats.inserted}, Updated: ${this.stats.updated}`);
    } catch (err) {
      console.error('[EU] Fatal error:', err.message);
      await this.pool.query(
        `UPDATE scrape_jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
        [err.message, jobId]
      );
    }

    return this.stats;
  }

  async _searchEUPortal(query) {
    try {
      let pageNumber = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await axios.get(API_BASE, {
          params: {
            apiKey: 'SEDIA',
            text: query,
            pageSize: PAGE_SIZE,
            pageNumber: pageNumber,
            type: 'org.eureqa.ftopics',
          },
          timeout: 30000,
          headers: { 'Accept': 'application/json' },
        });

        const data = response.data;
        if (!data || !data.results) {
          hasMore = false;
          break;
        }

        const results = data.results;
        this.stats.found += results.length;
        console.log(`[EU] Query "${query}" page ${pageNumber}: ${results.length} results`);

        for (const result of results) {
          await this._processEUResult(result);
        }

        if (results.length < PAGE_SIZE) {
          hasMore = false;
        } else {
          pageNumber++;
          if (pageNumber > 10) hasMore = false; // Safety cap
          await this._delay(DELAY);
        }
      }
    } catch (err) {
      console.error(`[EU] Error searching for "${query}":`, err.message);
      this.stats.errors++;
    }
  }

  async _processEUResult(result) {
    try {
      const metadata = result.metadata || {};
      const title = metadata.title?.value || metadata.identifier?.value || '';
      if (!title) return;

      const description = metadata.description?.value || metadata.summary?.value || '';
      const deadline = metadata.deadlineDate?.value ? new Date(metadata.deadlineDate.value) : null;
      const status = metadata.status?.value || '';
      const identifier = metadata.identifier?.value || '';
      const budgetStr = metadata.budget?.value || '';
      const topicType = metadata.topicType?.value || '';

      // Parse budget
      let fundingMax = null;
      if (budgetStr) {
        const match = budgetStr.match(/([\d,.]+)/);
        if (match) {
          fundingMax = parseFloat(match[1].replace(/,/g, ''));
          if (budgetStr.toLowerCase().includes('million')) fundingMax *= 1000000;
        }
      }

      // Map to sectors
      const sectors = this._mapEUSectors(title, description);
      const eligibilityTypes = this._mapEUEligibility(topicType, description);

      const applicationUrl = identifier
        ? `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/${identifier.toLowerCase()}`
        : 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/';

      const grantStatus = deadline && deadline < new Date() ? 'expired' : 'active';

      await this._upsertGrant({
        title: title.substring(0, 500),
        description: description.substring(0, 5000),
        funder_name: 'European Commission',
        funder_type: 'eu',
        country: 'EU',
        region: null,
        funding_amount_min: null,
        funding_amount_max: fundingMax,
        currency: 'EUR',
        deadline: deadline,
        is_rolling: !deadline,
        eligibility_types: eligibilityTypes,
        sectors: sectors,
        keywords: [identifier, 'eu', 'europe'].filter(Boolean),
        application_url: applicationUrl,
        source_url: applicationUrl,
        source_system: 'eu_portal',
        status: grantStatus,
      });
    } catch (err) {
      console.error('[EU] Error processing result:', err.message);
      this.stats.errors++;
    }
  }

  async _scrapeHorizonEurope() {
    console.log('[EU] Scraping Horizon Europe programs...');
    try {
      const response = await axios.get(API_BASE, {
        params: {
          apiKey: 'SEDIA',
          text: 'Horizon Europe',
          pageSize: PAGE_SIZE,
          pageNumber: 1,
          type: 'org.eureqa.ftopics',
        },
        timeout: 30000,
        headers: { 'Accept': 'application/json' },
      });

      if (response.data?.results) {
        for (const result of response.data.results) {
          await this._processEUResult(result);
        }
        console.log(`[EU] Horizon Europe: ${response.data.results.length} results`);
      }
    } catch (err) {
      console.error('[EU] Horizon Europe error:', err.message);
      this.stats.errors++;
    }
  }

  async _addCuratedEUPrograms() {
    console.log('[EU] Adding curated EU programs...');
    const programs = [
      {
        title: 'EIC Accelerator — Horizon Europe',
        description: 'The EIC Accelerator supports high-risk, high-impact SMEs and startups to develop and scale up breakthrough innovations. Grants up to \u20AC2.5M and equity up to \u20AC15M.',
        funder_name: 'European Innovation Council',
        funding_amount_min: 500000,
        funding_amount_max: 2500000,
        eligibility_types: ['sme', 'startup'],
        sectors: ['technology', 'clean-energy', 'healthcare', 'manufacturing'],
        application_url: 'https://eic.ec.europa.eu/eic-funding-opportunities/eic-accelerator_en',
        is_rolling: false,
      },
      {
        title: 'EIC Pathfinder — Horizon Europe',
        description: 'Supports visionary scientists, engineers and innovators to develop breakthrough technologies. Grants up to \u20AC3-4M for collaborative projects.',
        funder_name: 'European Innovation Council',
        funding_amount_min: 500000,
        funding_amount_max: 4000000,
        eligibility_types: ['research', 'sme'],
        sectors: ['technology', 'clean-energy', 'healthcare'],
        application_url: 'https://eic.ec.europa.eu/eic-funding-opportunities/eic-pathfinder_en',
        is_rolling: false,
      },
      {
        title: 'COSME Programme',
        description: 'EU programme for the Competitiveness of SMEs. Facilitates access to finance, markets, and supports entrepreneurship.',
        funder_name: 'European Commission',
        funding_amount_min: 0,
        funding_amount_max: 1000000,
        eligibility_types: ['sme', 'startup'],
        sectors: ['general'],
        application_url: 'https://ec.europa.eu/growth/smes/cosme_en',
        is_rolling: true,
      },
      {
        title: 'LIFE Programme — Environment & Climate Action',
        description: 'EU funding instrument for the environment and climate action. Supports projects for nature conservation, circular economy, and climate mitigation.',
        funder_name: 'European Commission',
        funding_amount_min: 500000,
        funding_amount_max: 10000000,
        eligibility_types: ['sme', 'nonprofit', 'research'],
        sectors: ['clean-energy', 'environment'],
        application_url: 'https://cinea.ec.europa.eu/programmes/life_en',
        is_rolling: false,
      },
      {
        title: 'Digital Europe Programme',
        description: 'Funding for digital transformation projects including AI, cybersecurity, advanced digital skills, and digital public services.',
        funder_name: 'European Commission',
        funding_amount_min: 100000,
        funding_amount_max: 5000000,
        eligibility_types: ['sme', 'research'],
        sectors: ['technology', 'ai'],
        application_url: 'https://digital-strategy.ec.europa.eu/en/activities/digital-programme',
        is_rolling: false,
      },
      {
        title: 'Erasmus for Young Entrepreneurs',
        description: 'Cross-border exchange programme helping new entrepreneurs gather skills needed to run a small firm by spending time with an experienced entrepreneur in another EU country.',
        funder_name: 'European Commission',
        funding_amount_min: 500,
        funding_amount_max: 6000,
        eligibility_types: ['startup'],
        sectors: ['general'],
        application_url: 'https://www.erasmus-entrepreneurs.eu/',
        is_rolling: true,
      },
      {
        title: 'InvestEU — SME Window',
        description: 'EU guarantee programme improving access to finance for SMEs. Supports innovation, sustainability, and growth through financial intermediaries.',
        funder_name: 'European Investment Fund',
        funding_amount_min: 25000,
        funding_amount_max: 7500000,
        eligibility_types: ['sme', 'startup', 'social_enterprise'],
        sectors: ['general'],
        application_url: 'https://investeu.europa.eu/',
        is_rolling: true,
      },
    ];

    for (const grant of programs) {
      await this._upsertGrant({
        ...grant,
        country: 'EU',
        region: null,
        funder_type: 'eu',
        currency: 'EUR',
        source_system: 'eu_curated',
        source_url: grant.application_url,
        keywords: ['eu', 'europe'],
        deadline: null,
        status: 'active',
      });
      this.stats.found++;
    }
  }

  _mapEUSectors(title, description) {
    const text = `${title} ${description}`.toLowerCase();
    const sectors = [];
    if (/health|medic|pharma|biotech/i.test(text)) sectors.push('healthcare');
    if (/digit|ai|artificial|cyber|software/i.test(text)) sectors.push('technology');
    if (/energy|climat|green|sustain|environment/i.test(text)) sectors.push('clean-energy');
    if (/agri|food|farm/i.test(text)) sectors.push('agriculture');
    if (/manufactur|industr/i.test(text)) sectors.push('manufacturing');
    if (/social|inclus|communit/i.test(text)) sectors.push('social-impact');
    if (/transport|mobil/i.test(text)) sectors.push('transportation');
    if (/space|aero/i.test(text)) sectors.push('aerospace');
    if (/educ|train|skill/i.test(text)) sectors.push('education');
    if (sectors.length === 0) sectors.push('general');
    return sectors;
  }

  _mapEUEligibility(topicType, description) {
    const types = new Set();
    const text = `${topicType} ${description}`.toLowerCase();
    if (/sme|small.*medium|business/i.test(text)) types.add('sme');
    if (/startup|start-up/i.test(text)) types.add('startup');
    if (/research|academ|universit/i.test(text)) types.add('research');
    if (/ngo|non-?profit|civil\s+society/i.test(text)) types.add('nonprofit');
    if (/social\s+enter/i.test(text)) types.add('social_enterprise');
    if (types.size === 0) types.add('any');
    return [...types];
  }

  async _upsertGrant(grant) {
    try {
      const result = await this.pool.query(
        `INSERT INTO grants (title, description, funder_name, funder_type, country, region, funding_amount_min, funding_amount_max, currency, deadline, is_rolling, eligibility_types, sectors, keywords, application_url, source_url, source_system, last_verified, status)
         VALUES ($1, $2, $3, $4::funder_type, $5, $6, $7, $8, $9, $10, $11, $12::eligibility_type[], $13, $14, $15, $16, $17, NOW(), $18::grant_status)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          grant.title,
          grant.description,
          grant.funder_name,
          grant.funder_type,
          grant.country,
          grant.region || null,
          grant.funding_amount_min,
          grant.funding_amount_max,
          grant.currency,
          grant.deadline || null,
          grant.is_rolling,
          `{${grant.eligibility_types.join(',')}}`,
          `{${grant.sectors.map(s => `"${s}"`).join(',')}}`,
          `{${(grant.keywords || []).map(k => `"${k}"`).join(',')}}`,
          grant.application_url,
          grant.source_url,
          grant.source_system,
          grant.status || 'active',
        ]
      );

      if (result.rows.length > 0) {
        this.stats.inserted++;
      } else {
        await this.pool.query(
          `UPDATE grants SET description = $1, funding_amount_max = $2, last_verified = NOW(), updated_at = NOW()
           WHERE title = $3 AND source_system = $4`,
          [grant.description, grant.funding_amount_max, grant.title, grant.source_system]
        );
        this.stats.updated++;
      }
    } catch (err) {
      console.error(`[EU] Error upserting "${grant.title}":`, err.message);
      this.stats.errors++;
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { EUGrantsScraper };
