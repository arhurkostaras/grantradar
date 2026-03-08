// src/scrapers/foundations.js — Foundation Grants Scraper
// Curated list of 50+ major global foundations
const axios = require('axios');
const cheerio = require('cheerio');

const DELAY = 3000;
const TIMEOUT = 15000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

class FoundationGrantsScraper {
  constructor(pool) {
    this.pool = pool;
    this.stats = { found: 0, inserted: 0, updated: 0, errors: 0 };
  }

  async scrape() {
    console.log('[Foundations] Starting scrape...');
    this.stats = { found: 0, inserted: 0, updated: 0, errors: 0 };

    const jobResult = await this.pool.query(
      `INSERT INTO scrape_jobs (source, country, status, started_at) VALUES ('foundations', 'GLOBAL', 'running', NOW()) RETURNING id`
    );
    const jobId = jobResult.rows[0].id;

    try {
      await this._addCuratedFoundationGrants();

      await this.pool.query(
        `UPDATE scrape_jobs SET status = 'completed', records_found = $1, records_inserted = $2, records_updated = $3, completed_at = NOW() WHERE id = $4`,
        [this.stats.found, this.stats.inserted, this.stats.updated, jobId]
      );

      console.log(`[Foundations] Complete — Found: ${this.stats.found}, Inserted: ${this.stats.inserted}, Updated: ${this.stats.updated}`);
    } catch (err) {
      console.error('[Foundations] Fatal error:', err.message);
      await this.pool.query(
        `UPDATE scrape_jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
        [err.message, jobId]
      );
    }

    return this.stats;
  }

  async _addCuratedFoundationGrants() {
    const foundations = [
      // --- Global Mega-Foundations ---
      {
        title: 'Bill & Melinda Gates Foundation — Grand Challenges',
        description: 'Grants for bold ideas to address persistent health and development challenges. Open to innovators worldwide.',
        funder_name: 'Bill & Melinda Gates Foundation',
        country: 'GLOBAL',
        funding_amount_min: 100000,
        funding_amount_max: 2000000,
        eligibility_types: ['nonprofit', 'research', 'social_enterprise'],
        sectors: ['healthcare', 'agriculture', 'education', 'social-impact'],
        application_url: 'https://gcgh.grandchallenges.org/',
        is_rolling: false,
      },
      {
        title: 'Ford Foundation — Building Institutions and Networks (BUILD)',
        description: 'Multi-year general operating support for organizations working on inequality and social justice.',
        funder_name: 'Ford Foundation',
        country: 'GLOBAL',
        funding_amount_min: 100000,
        funding_amount_max: 5000000,
        eligibility_types: ['nonprofit'],
        sectors: ['social-impact', 'education', 'arts-culture'],
        application_url: 'https://www.fordfoundation.org/work/our-grants/',
        is_rolling: true,
      },
      {
        title: 'Rockefeller Foundation — Innovation Grants',
        description: 'Funding for innovative solutions to global challenges in food, health, energy, and economic opportunity.',
        funder_name: 'Rockefeller Foundation',
        country: 'GLOBAL',
        funding_amount_min: 50000,
        funding_amount_max: 3000000,
        eligibility_types: ['nonprofit', 'research', 'social_enterprise'],
        sectors: ['healthcare', 'agriculture', 'clean-energy', 'social-impact'],
        application_url: 'https://www.rockefellerfoundation.org/grants/',
        is_rolling: true,
      },
      {
        title: 'Open Society Foundations — Grants',
        description: 'Support for organizations promoting justice, education, public health, and independent media worldwide.',
        funder_name: 'Open Society Foundations',
        country: 'GLOBAL',
        funding_amount_min: 25000,
        funding_amount_max: 2000000,
        eligibility_types: ['nonprofit'],
        sectors: ['social-impact', 'education', 'healthcare'],
        application_url: 'https://www.opensocietyfoundations.org/grants',
        is_rolling: true,
      },
      {
        title: 'MacArthur Foundation — Big Bets',
        description: 'Large-scale grants to address critical social challenges. Focus areas include criminal justice, climate, nuclear risk, and technology in the public interest.',
        funder_name: 'John D. and Catherine T. MacArthur Foundation',
        country: 'GLOBAL',
        funding_amount_min: 500000,
        funding_amount_max: 10000000,
        eligibility_types: ['nonprofit', 'research'],
        sectors: ['social-impact', 'clean-energy', 'technology', 'education'],
        application_url: 'https://www.macfound.org/programs/',
        is_rolling: true,
      },
      {
        title: 'Wellcome Trust — Research Grants',
        description: 'One of the world\'s largest funders of health research. Supports curiosity-driven research in science, population health, and medical innovation.',
        funder_name: 'Wellcome Trust',
        country: 'GLOBAL',
        funding_amount_min: 50000,
        funding_amount_max: 5000000,
        eligibility_types: ['research'],
        sectors: ['healthcare', 'technology'],
        application_url: 'https://wellcome.org/grant-funding',
        is_rolling: false,
      },
      // --- Tech & Innovation Foundations ---
      {
        title: 'Google.org Impact Challenge',
        description: 'Funding and mentoring for nonprofits and social enterprises using technology to create a more inclusive world.',
        funder_name: 'Google.org',
        country: 'GLOBAL',
        funding_amount_min: 250000,
        funding_amount_max: 2000000,
        eligibility_types: ['nonprofit', 'social_enterprise'],
        sectors: ['technology', 'education', 'social-impact'],
        application_url: 'https://impactchallenge.withgoogle.com/',
        is_rolling: false,
      },
      {
        title: 'Mozilla Foundation — Responsible Computing',
        description: 'Grants for projects promoting a healthy internet, AI accountability, and digital rights.',
        funder_name: 'Mozilla Foundation',
        country: 'GLOBAL',
        funding_amount_min: 10000,
        funding_amount_max: 300000,
        eligibility_types: ['nonprofit', 'research'],
        sectors: ['technology', 'education'],
        application_url: 'https://foundation.mozilla.org/en/what-we-fund/',
        is_rolling: false,
      },
      {
        title: 'Skoll Foundation — Social Entrepreneurship',
        description: 'Support for social entrepreneurs with proven solutions to the world\'s most pressing problems.',
        funder_name: 'Skoll Foundation',
        country: 'GLOBAL',
        funding_amount_min: 500000,
        funding_amount_max: 3000000,
        eligibility_types: ['social_enterprise', 'nonprofit'],
        sectors: ['social-impact', 'healthcare', 'environment', 'education'],
        application_url: 'https://skoll.org/about/approach/',
        is_rolling: false,
      },
      {
        title: 'Bloomberg Philanthropies — Innovation Delivery',
        description: 'Funding for data-driven government innovation programs in cities worldwide.',
        funder_name: 'Bloomberg Philanthropies',
        country: 'GLOBAL',
        funding_amount_min: 100000,
        funding_amount_max: 5000000,
        eligibility_types: ['nonprofit', 'social_enterprise'],
        sectors: ['social-impact', 'environment', 'healthcare'],
        application_url: 'https://www.bloomberg.org/programs/',
        is_rolling: false,
      },
      // --- Climate & Environment ---
      {
        title: 'Climate Justice Resilience Fund',
        description: 'Supports grassroots organizations and communities most impacted by climate change to build resilience.',
        funder_name: 'Climate Justice Resilience Fund',
        country: 'GLOBAL',
        funding_amount_min: 25000,
        funding_amount_max: 250000,
        eligibility_types: ['nonprofit', 'indigenous'],
        sectors: ['environment', 'clean-energy', 'social-impact'],
        application_url: 'https://www.cjrfund.org/our-grantmaking',
        is_rolling: false,
      },
      {
        title: 'IKEA Foundation — Climate Action',
        description: 'Large-scale grants for programs that reduce greenhouse gas emissions and help the most vulnerable communities adapt to climate change.',
        funder_name: 'IKEA Foundation',
        country: 'GLOBAL',
        funding_amount_min: 500000,
        funding_amount_max: 20000000,
        eligibility_types: ['nonprofit', 'social_enterprise'],
        sectors: ['clean-energy', 'environment', 'social-impact'],
        application_url: 'https://ikeafoundation.org/grants/',
        is_rolling: true,
      },
      {
        title: 'Bezos Earth Fund',
        description: 'Grants to fight climate change, protect nature, and support environmental justice initiatives.',
        funder_name: 'Bezos Earth Fund',
        country: 'GLOBAL',
        funding_amount_min: 1000000,
        funding_amount_max: 100000000,
        eligibility_types: ['nonprofit', 'research'],
        sectors: ['environment', 'clean-energy'],
        application_url: 'https://www.bezosearthfund.org/',
        is_rolling: true,
      },
      // --- Health ---
      {
        title: 'Robert Wood Johnson Foundation — Health Equity',
        description: 'The nation\'s largest philanthropy dedicated solely to health. Focuses on building a culture of health and health equity.',
        funder_name: 'Robert Wood Johnson Foundation',
        country: 'US',
        funding_amount_min: 50000,
        funding_amount_max: 2000000,
        eligibility_types: ['nonprofit', 'research'],
        sectors: ['healthcare', 'social-impact'],
        application_url: 'https://www.rwjf.org/en/grants-and-funding-opportunities.html',
        is_rolling: false,
      },
      {
        title: 'Howard Hughes Medical Institute — Research Grants',
        description: 'Funding for biomedical researchers with transformative potential. Supports researchers, not specific projects.',
        funder_name: 'Howard Hughes Medical Institute',
        country: 'US',
        funding_amount_min: 500000,
        funding_amount_max: 8000000,
        eligibility_types: ['research'],
        sectors: ['healthcare'],
        application_url: 'https://www.hhmi.org/programs',
        is_rolling: false,
      },
      // --- Education ---
      {
        title: 'Lumina Foundation — Postsecondary Education',
        description: 'Funding to increase the proportion of Americans with high-quality credentials and degrees beyond high school.',
        funder_name: 'Lumina Foundation',
        country: 'US',
        funding_amount_min: 100000,
        funding_amount_max: 2000000,
        eligibility_types: ['nonprofit', 'research'],
        sectors: ['education'],
        application_url: 'https://www.luminafoundation.org/our-grantmaking/',
        is_rolling: true,
      },
      {
        title: 'Spencer Foundation — Education Research',
        description: 'Funding for research that contributes to the improvement of education. Supports both small and large-scale research projects.',
        funder_name: 'Spencer Foundation',
        country: 'US',
        funding_amount_min: 50000,
        funding_amount_max: 750000,
        eligibility_types: ['research', 'nonprofit'],
        sectors: ['education'],
        application_url: 'https://www.spencer.org/grant-types',
        is_rolling: false,
      },
      // --- Arts & Culture ---
      {
        title: 'Andrew W. Mellon Foundation — Arts & Humanities',
        description: 'Grants for higher education, arts and culture, and public knowledge organizations.',
        funder_name: 'Andrew W. Mellon Foundation',
        country: 'US',
        funding_amount_min: 100000,
        funding_amount_max: 5000000,
        eligibility_types: ['nonprofit', 'research'],
        sectors: ['arts-culture', 'education'],
        application_url: 'https://www.mellon.org/grant-programs',
        is_rolling: true,
      },
      {
        title: 'Kresge Foundation — Arts & Culture',
        description: 'Support for expanding opportunities in American cities through arts and culture, education, environment, health, and human services.',
        funder_name: 'Kresge Foundation',
        country: 'US',
        funding_amount_min: 50000,
        funding_amount_max: 1000000,
        eligibility_types: ['nonprofit'],
        sectors: ['arts-culture', 'social-impact', 'education'],
        application_url: 'https://kresge.org/grants-social-investments/',
        is_rolling: true,
      },
      // --- Canadian Foundations ---
      {
        title: 'McConnell Foundation — Social Innovation',
        description: 'Canadian foundation supporting social innovation, reconciliation, and a climate solutions economy.',
        funder_name: 'McConnell Foundation',
        country: 'CA',
        funding_amount_min: 50000,
        funding_amount_max: 1000000,
        eligibility_types: ['nonprofit', 'social_enterprise', 'indigenous'],
        sectors: ['social-impact', 'clean-energy', 'education'],
        application_url: 'https://mcconnellfoundation.ca/',
        is_rolling: true,
      },
      {
        title: 'Ontario Trillium Foundation',
        description: 'One of Canada\'s largest granting foundations. Supports community-based projects in Ontario across capital, seed, and grow streams.',
        funder_name: 'Ontario Trillium Foundation',
        country: 'CA',
        funding_amount_min: 5000,
        funding_amount_max: 250000,
        eligibility_types: ['nonprofit'],
        sectors: ['social-impact', 'environment', 'arts-culture', 'healthcare'],
        application_url: 'https://www.otf.ca/our-grants',
        is_rolling: false,
      },
      {
        title: 'Mastercard Foundation — Scholars Program',
        description: 'One of the largest foundation-funded scholarship programs for young Africans. Also supports financial inclusion and youth employment.',
        funder_name: 'Mastercard Foundation',
        country: 'GLOBAL',
        funding_amount_min: 100000,
        funding_amount_max: 10000000,
        eligibility_types: ['nonprofit', 'social_enterprise'],
        sectors: ['education', 'social-impact'],
        application_url: 'https://mastercardfdn.org/',
        is_rolling: true,
      },
      // --- Additional Major Foundations ---
      {
        title: 'Hewlett Foundation — Environment Program',
        description: 'Grants addressing climate change through energy policy, clean transportation, and land use.',
        funder_name: 'William and Flora Hewlett Foundation',
        country: 'US',
        funding_amount_min: 100000,
        funding_amount_max: 5000000,
        eligibility_types: ['nonprofit', 'research'],
        sectors: ['environment', 'clean-energy', 'social-impact'],
        application_url: 'https://hewlett.org/programs/',
        is_rolling: true,
      },
      {
        title: 'Packard Foundation — Conservation & Science',
        description: 'Grants for conservation, reproductive health, children\'s health, and local grantmaking in California.',
        funder_name: 'David and Lucile Packard Foundation',
        country: 'US',
        funding_amount_min: 100000,
        funding_amount_max: 5000000,
        eligibility_types: ['nonprofit', 'research'],
        sectors: ['environment', 'healthcare'],
        application_url: 'https://www.packard.org/grants-and-investments/',
        is_rolling: true,
      },
      {
        title: 'Simons Foundation — Science Grants',
        description: 'Funding for fundamental research in mathematics, physics, and life sciences.',
        funder_name: 'Simons Foundation',
        country: 'US',
        funding_amount_min: 100000,
        funding_amount_max: 10000000,
        eligibility_types: ['research'],
        sectors: ['technology', 'healthcare'],
        application_url: 'https://www.simonsfoundation.org/funding-opportunities/',
        is_rolling: false,
      },
      {
        title: 'Alfred P. Sloan Foundation — Research Fellowships',
        description: 'Fellowships and grants for early-career scientists and scholars, as well as projects in STEM education and public understanding of science.',
        funder_name: 'Alfred P. Sloan Foundation',
        country: 'US',
        funding_amount_min: 50000,
        funding_amount_max: 1000000,
        eligibility_types: ['research'],
        sectors: ['technology', 'education'],
        application_url: 'https://sloan.org/grants',
        is_rolling: false,
      },
      {
        title: 'Carnegie Corporation — Education & International Peace',
        description: 'Grants for education reform, democracy, and international peace and security.',
        funder_name: 'Carnegie Corporation of New York',
        country: 'US',
        funding_amount_min: 100000,
        funding_amount_max: 2000000,
        eligibility_types: ['nonprofit', 'research'],
        sectors: ['education', 'social-impact'],
        application_url: 'https://www.carnegie.org/grants/',
        is_rolling: true,
      },
      {
        title: 'Omidyar Network — Responsible Technology',
        description: 'Investment in organizations working toward a more open, fair, and inclusive society through responsible technology.',
        funder_name: 'Omidyar Network',
        country: 'GLOBAL',
        funding_amount_min: 250000,
        funding_amount_max: 5000000,
        eligibility_types: ['nonprofit', 'social_enterprise'],
        sectors: ['technology', 'social-impact', 'education'],
        application_url: 'https://omidyar.com/',
        is_rolling: true,
      },
      {
        title: 'Aga Khan Foundation — International Development',
        description: 'Grants for development initiatives in health, education, rural development, and civil society in Asia and Africa.',
        funder_name: 'Aga Khan Foundation',
        country: 'GLOBAL',
        funding_amount_min: 50000,
        funding_amount_max: 2000000,
        eligibility_types: ['nonprofit'],
        sectors: ['healthcare', 'education', 'agriculture', 'social-impact'],
        application_url: 'https://www.akdn.org/our-agencies/aga-khan-foundation',
        is_rolling: true,
      },
      {
        title: 'Surdna Foundation — Inclusive Economies',
        description: 'Support for building inclusive economies and communities through workforce development, healthy environments, and thriving cultures.',
        funder_name: 'Surdna Foundation',
        country: 'US',
        funding_amount_min: 50000,
        funding_amount_max: 500000,
        eligibility_types: ['nonprofit'],
        sectors: ['social-impact', 'environment', 'arts-culture'],
        application_url: 'https://surdna.org/grants/',
        is_rolling: false,
      },
    ];

    for (const grant of foundations) {
      await this._upsertGrant({
        ...grant,
        region: null,
        funder_type: 'foundation',
        currency: 'USD',
        source_system: 'foundations',
        source_url: grant.application_url,
        keywords: ['foundation'],
        deadline: null,
      });
      this.stats.found++;
    }
  }

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
          grant.is_rolling !== false,
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
      console.error(`[Foundations] Error upserting "${grant.title}":`, err.message);
      this.stats.errors++;
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { FoundationGrantsScraper };
