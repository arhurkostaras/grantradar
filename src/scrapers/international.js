// src/scrapers/international.js — UK, Australia, Singapore, UAE Grants Scraper
const axios = require('axios');
const cheerio = require('cheerio');

const DELAY = 2000;
const TIMEOUT = 15000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

class InternationalGrantsScraper {
  constructor(pool) {
    this.pool = pool;
    this.stats = { found: 0, inserted: 0, updated: 0, errors: 0 };
  }

  async scrape(country = 'all') {
    console.log(`[International] Starting scrape for: ${country}`);
    this.stats = { found: 0, inserted: 0, updated: 0, errors: 0 };

    const jobResult = await this.pool.query(
      `INSERT INTO scrape_jobs (source, country, status, started_at) VALUES ('international', $1, 'running', NOW()) RETURNING id`,
      [country]
    );
    const jobId = jobResult.rows[0].id;

    try {
      if (country === 'all' || country === 'UK') await this._scrapeUK();
      if (country === 'all' || country === 'AU') await this._scrapeAustralia();
      if (country === 'all' || country === 'SG') await this._scrapeSingapore();
      if (country === 'all' || country === 'UAE') await this._scrapeUAE();

      await this.pool.query(
        `UPDATE scrape_jobs SET status = 'completed', records_found = $1, records_inserted = $2, records_updated = $3, completed_at = NOW() WHERE id = $4`,
        [this.stats.found, this.stats.inserted, this.stats.updated, jobId]
      );

      console.log(`[International] Complete — Found: ${this.stats.found}, Inserted: ${this.stats.inserted}, Updated: ${this.stats.updated}`);
    } catch (err) {
      console.error('[International] Fatal error:', err.message);
      await this.pool.query(
        `UPDATE scrape_jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
        [err.message, jobId]
      );
    }

    return this.stats;
  }

  // -------------------------------------------------------------------------
  // UK Grants
  // -------------------------------------------------------------------------

  async _scrapeUK() {
    console.log('[International] Scraping UK grants...');
    const ukGrants = [
      {
        title: 'Innovate UK Smart Grants',
        description: 'Funding for game-changing and disruptive innovations from any area of technology across any sector. Open to single or collaborative projects.',
        funder_name: 'Innovate UK',
        funding_amount_min: 25000,
        funding_amount_max: 2000000,
        eligibility_types: ['sme', 'startup', 'research'],
        sectors: ['technology', 'clean-energy', 'healthcare', 'manufacturing'],
        application_url: 'https://www.ukri.org/councils/innovate-uk/',
        is_rolling: true,
      },
      {
        title: 'R&D Tax Relief for SMEs',
        description: 'UK tax relief for SMEs that spend money developing new products, processes, or services. Enhanced deduction of up to 230% of qualifying costs.',
        funder_name: 'HMRC',
        funding_amount_min: 0,
        funding_amount_max: 500000,
        eligibility_types: ['sme', 'startup'],
        sectors: ['technology', 'manufacturing', 'clean-energy', 'healthcare'],
        application_url: 'https://www.gov.uk/guidance/corporation-tax-research-and-development-rd-relief',
        is_rolling: true,
      },
      {
        title: 'British Business Bank Start Up Loans',
        description: 'Government-backed personal loans for business purposes of up to £25,000 with free mentoring and support.',
        funder_name: 'British Business Bank',
        funding_amount_min: 500,
        funding_amount_max: 25000,
        eligibility_types: ['startup', 'sme'],
        sectors: ['general'],
        application_url: 'https://www.startuploans.co.uk/',
        is_rolling: true,
      },
      {
        title: 'Knowledge Transfer Partnerships (KTP)',
        description: 'UK-wide programme enabling businesses to access academic expertise and new graduates for innovation projects. Grants cover up to 67% of costs for SMEs.',
        funder_name: 'Innovate UK',
        funding_amount_min: 30000,
        funding_amount_max: 300000,
        eligibility_types: ['sme', 'research'],
        sectors: ['technology', 'manufacturing', 'healthcare'],
        application_url: 'https://www.ktp-uk.org/',
        is_rolling: true,
      },
      {
        title: 'Innovate UK Biomedical Catalyst',
        description: 'Funding for life sciences SMEs to translate breakthrough science into new treatments, diagnostics and devices.',
        funder_name: 'Innovate UK',
        funding_amount_min: 100000,
        funding_amount_max: 4000000,
        eligibility_types: ['sme', 'startup', 'research'],
        sectors: ['healthcare'],
        application_url: 'https://www.ukri.org/councils/innovate-uk/',
        is_rolling: false,
      },
      {
        title: 'Net Zero Innovation Portfolio',
        description: 'UK government funding for clean energy innovation. Supports technologies across power, buildings, industry, and greenhouse gas removal.',
        funder_name: 'Department for Energy Security and Net Zero',
        funding_amount_min: 50000,
        funding_amount_max: 10000000,
        eligibility_types: ['sme', 'startup', 'research'],
        sectors: ['clean-energy', 'environment'],
        application_url: 'https://www.gov.uk/government/collections/net-zero-innovation-portfolio',
        is_rolling: false,
      },
    ];

    for (const grant of ukGrants) {
      await this._upsertGrant({
        ...grant,
        country: 'UK',
        funder_type: 'government',
        currency: 'GBP',
        source_system: 'uk_gov',
        source_url: grant.application_url,
        keywords: ['uk', 'united-kingdom'],
      });
      this.stats.found++;
    }
  }

  // -------------------------------------------------------------------------
  // Australia Grants
  // -------------------------------------------------------------------------

  async _scrapeAustralia() {
    console.log('[International] Scraping Australia grants...');
    const auGrants = [
      {
        title: 'R&D Tax Incentive',
        description: 'Australian government tax offset for companies conducting eligible R&D activities. Refundable offset of 43.5% for companies with turnover under $20M.',
        funder_name: 'AusIndustry',
        funding_amount_min: 0,
        funding_amount_max: 4000000,
        eligibility_types: ['sme', 'startup', 'research'],
        sectors: ['technology', 'manufacturing', 'clean-energy', 'healthcare'],
        application_url: 'https://business.gov.au/grants-and-programs/research-and-development-tax-incentive',
        is_rolling: true,
      },
      {
        title: 'Entrepreneurs\' Programme — Accelerating Commercialisation',
        description: 'Matched funding of up to $1M to help SMEs commercialise novel products, processes and services.',
        funder_name: 'Department of Industry, Science and Resources',
        funding_amount_min: 50000,
        funding_amount_max: 1000000,
        eligibility_types: ['sme', 'startup'],
        sectors: ['technology', 'manufacturing', 'healthcare'],
        application_url: 'https://business.gov.au/grants-and-programs/accelerating-commercialisation',
        is_rolling: true,
      },
      {
        title: 'Export Market Development Grants (EMDG)',
        description: 'Financial assistance to Australian SMEs to develop export markets. Reimbursement of up to 50% of eligible export promotion expenses.',
        funder_name: 'Austrade',
        funding_amount_min: 5000,
        funding_amount_max: 150000,
        eligibility_types: ['sme'],
        sectors: ['general'],
        application_url: 'https://www.austrade.gov.au/en/how-austrade-can-help/grants-and-assistance/emdg',
        is_rolling: false,
      },
      {
        title: 'Cooperative Research Centres (CRC) Grants',
        description: 'Funding for industry-led collaborations between industry, researchers and the community. Supports medium to long-term industry-led research.',
        funder_name: 'Department of Industry, Science and Resources',
        funding_amount_min: 1000000,
        funding_amount_max: 50000000,
        eligibility_types: ['sme', 'research'],
        sectors: ['technology', 'agriculture', 'healthcare', 'manufacturing'],
        application_url: 'https://business.gov.au/grants-and-programs/cooperative-research-centres-crc-grants',
        is_rolling: false,
      },
      {
        title: 'Modern Manufacturing Initiative',
        description: 'Grants to support Australian manufacturers to scale up, compete internationally and create jobs in priority manufacturing areas.',
        funder_name: 'Department of Industry, Science and Resources',
        funding_amount_min: 1000000,
        funding_amount_max: 20000000,
        eligibility_types: ['sme'],
        sectors: ['manufacturing', 'technology', 'clean-energy'],
        application_url: 'https://business.gov.au/grants-and-programs/modern-manufacturing-initiative',
        is_rolling: false,
      },
    ];

    for (const grant of auGrants) {
      await this._upsertGrant({
        ...grant,
        country: 'AU',
        funder_type: 'government',
        currency: 'AUD',
        source_system: 'au_gov',
        source_url: grant.application_url,
        keywords: ['australia'],
      });
      this.stats.found++;
    }
  }

  // -------------------------------------------------------------------------
  // Singapore Grants
  // -------------------------------------------------------------------------

  async _scrapeSingapore() {
    console.log('[International] Scraping Singapore grants...');
    const sgGrants = [
      {
        title: 'Enterprise Development Grant (EDG)',
        description: 'Supports Singapore businesses to upgrade capabilities, innovate and internationalize. Covers up to 50% of project costs (up to 80% for SMEs under certain conditions).',
        funder_name: 'Enterprise Singapore',
        funding_amount_min: 10000,
        funding_amount_max: 1000000,
        eligibility_types: ['sme', 'startup'],
        sectors: ['technology', 'manufacturing', 'retail'],
        application_url: 'https://www.enterprisesg.gov.sg/financial-support/enterprise-development-grant',
        is_rolling: true,
      },
      {
        title: 'Startup SG Founder',
        description: 'Mentorship and startup capital grant of S$50,000 for first-time entrepreneurs with innovative business concepts.',
        funder_name: 'Enterprise Singapore',
        funding_amount_min: 30000,
        funding_amount_max: 50000,
        eligibility_types: ['startup'],
        sectors: ['technology', 'general'],
        application_url: 'https://www.startupsg.gov.sg/programmes/founder',
        is_rolling: true,
      },
      {
        title: 'Startup SG Tech',
        description: 'Fast-track funding for tech startups to commercialise proprietary technology. Proof of Concept (up to S$250K) and Proof of Value (up to S$500K).',
        funder_name: 'Enterprise Singapore',
        funding_amount_min: 50000,
        funding_amount_max: 500000,
        eligibility_types: ['startup', 'sme'],
        sectors: ['technology'],
        application_url: 'https://www.startupsg.gov.sg/programmes/tech',
        is_rolling: true,
      },
      {
        title: 'Productivity Solutions Grant (PSG)',
        description: 'Supports businesses to adopt pre-approved IT solutions and equipment to enhance productivity. Covers up to 50% of qualifying costs.',
        funder_name: 'Enterprise Singapore',
        funding_amount_min: 5000,
        funding_amount_max: 30000,
        eligibility_types: ['sme'],
        sectors: ['general', 'retail', 'technology'],
        application_url: 'https://www.enterprisesg.gov.sg/financial-support/productivity-solutions-grant',
        is_rolling: true,
      },
      {
        title: 'Research Incentive Scheme for Companies (RISC)',
        description: 'Co-funding for companies to undertake R&D projects in partnership with research institutions in Singapore.',
        funder_name: 'Economic Development Board',
        funding_amount_min: 100000,
        funding_amount_max: 2000000,
        eligibility_types: ['sme', 'research'],
        sectors: ['technology', 'manufacturing', 'healthcare'],
        application_url: 'https://www.edb.gov.sg/en/how-we-help/incentives-and-schemes.html',
        is_rolling: true,
      },
    ];

    for (const grant of sgGrants) {
      await this._upsertGrant({
        ...grant,
        country: 'SG',
        funder_type: 'government',
        currency: 'SGD',
        source_system: 'sg_gov',
        source_url: grant.application_url,
        keywords: ['singapore'],
      });
      this.stats.found++;
    }
  }

  // -------------------------------------------------------------------------
  // UAE Grants
  // -------------------------------------------------------------------------

  async _scrapeUAE() {
    console.log('[International] Scraping UAE grants...');
    const uaeGrants = [
      {
        title: 'ADIO Innovation Programme',
        description: 'Abu Dhabi Investment Office support for innovative companies establishing operations in Abu Dhabi. Provides financial and non-financial incentives.',
        funder_name: 'Abu Dhabi Investment Office (ADIO)',
        funding_amount_min: 50000,
        funding_amount_max: 5000000,
        eligibility_types: ['sme', 'startup'],
        sectors: ['technology', 'healthcare', 'agriculture', 'clean-energy'],
        application_url: 'https://www.investinabudhabi.gov.ae/en/incentives',
        is_rolling: true,
      },
      {
        title: 'Dubai SME 100 Programme',
        description: 'Dubai SME initiative to support and rank top 100 UAE SMEs. Provides visibility, networking, and access to funding and government contracts.',
        funder_name: 'Dubai SME',
        funding_amount_min: 0,
        funding_amount_max: 500000,
        eligibility_types: ['sme', 'startup'],
        sectors: ['general', 'technology'],
        application_url: 'https://www.sme.ae/en/programmes',
        is_rolling: false,
      },
      {
        title: 'Mohammed bin Rashid Innovation Fund',
        description: 'Government-backed fund to support innovative projects in the UAE. Provides guarantees enabling innovators to access funding from partner banks.',
        funder_name: 'Ministry of Finance, UAE',
        funding_amount_min: 100000,
        funding_amount_max: 3000000,
        eligibility_types: ['sme', 'startup', 'research'],
        sectors: ['technology', 'clean-energy', 'healthcare'],
        application_url: 'https://www.mbrif.ae/',
        is_rolling: true,
      },
      {
        title: 'Khalifa Fund for Enterprise Development',
        description: 'Support for UAE nationals to start and grow businesses. Offers financing, mentoring, training, and business incubation services.',
        funder_name: 'Khalifa Fund',
        funding_amount_min: 10000,
        funding_amount_max: 2500000,
        eligibility_types: ['sme', 'startup'],
        sectors: ['general'],
        application_url: 'https://www.khalifafund.ae/',
        is_rolling: true,
      },
    ];

    for (const grant of uaeGrants) {
      await this._upsertGrant({
        ...grant,
        country: 'AE',
        funder_type: 'government',
        currency: 'AED',
        source_system: 'uae_gov',
        source_url: grant.application_url,
        keywords: ['uae', 'united-arab-emirates'],
      });
      this.stats.found++;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async _upsertGrant(grant) {
    try {
      const result = await this.pool.query(
        `INSERT INTO grants (title, description, funder_name, funder_type, country, region, funding_amount_min, funding_amount_max, currency, deadline, is_rolling, eligibility_types, sectors, keywords, application_url, source_url, source_system, last_verified, status)
         VALUES ($1, $2, $3, $4::funder_type, $5, $6, $7, $8, $9, $10, $11, $12::eligibility_type[], $13, $14, $15, $16, $17, NOW(), 'active')
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
      console.error(`[International] Error upserting "${grant.title}":`, err.message);
      this.stats.errors++;
    }
  }

  async _fetch(url) {
    try {
      const response = await axios.get(url, {
        timeout: TIMEOUT,
        headers: { 'User-Agent': USER_AGENT },
        maxRedirects: 5,
        validateStatus: (status) => status < 400,
      });
      return typeof response.data === 'string' ? response.data : '';
    } catch { return null; }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { InternationalGrantsScraper };
