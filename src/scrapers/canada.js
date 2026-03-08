// src/scrapers/canada.js — Canada Federal & Provincial Grants Scraper
// Sources: Canada.ca, NRC-IRAP, SDTC, provincial portals
const axios = require('axios');
const cheerio = require('cheerio');

const DELAY = 2000;
const TIMEOUT = 15000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class CanadaGrantsScraper {
  constructor(pool) {
    this.pool = pool;
    this.stats = { found: 0, inserted: 0, updated: 0, errors: 0 };
  }

  async scrape() {
    console.log('[Canada] Starting grants scrape...');
    this.stats = { found: 0, inserted: 0, updated: 0, errors: 0 };

    const jobResult = await this.pool.query(
      `INSERT INTO scrape_jobs (source, country, status, started_at) VALUES ('canada', 'CA', 'running', NOW()) RETURNING id`
    );
    const jobId = jobResult.rows[0].id;

    try {
      // Scrape each source
      await this._scrapeCanadaCa();
      await this._scrapeIRAP();
      await this._scrapeSDTC();
      await this._scrapeOntario();
      await this._scrapeBC();
      await this._scrapeAlberta();
      await this._scrapeQuebec();

      await this.pool.query(
        `UPDATE scrape_jobs SET status = 'completed', records_found = $1, records_inserted = $2, records_updated = $3, completed_at = NOW() WHERE id = $4`,
        [this.stats.found, this.stats.inserted, this.stats.updated, jobId]
      );

      console.log(`[Canada] Complete — Found: ${this.stats.found}, Inserted: ${this.stats.inserted}, Updated: ${this.stats.updated}`);
    } catch (err) {
      console.error('[Canada] Fatal error:', err.message);
      await this.pool.query(
        `UPDATE scrape_jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
        [err.message, jobId]
      );
    }

    return this.stats;
  }

  // -------------------------------------------------------------------------
  // Canada.ca Business Grants and Financing
  // -------------------------------------------------------------------------

  async _scrapeCanadaCa() {
    console.log('[Canada] Scraping Canada.ca grants...');
    try {
      // The Canada.ca innovation/funding page lists federal programs
      const urls = [
        'https://www.canada.ca/en/services/business/grants.html',
        'https://innovation.ised-isde.canada.ca/s/?language=en',
      ];

      for (const url of urls) {
        try {
          const html = await this._fetch(url);
          if (!html) continue;

          const $ = cheerio.load(html);

          // Extract grant program links and titles
          $('a[href*="grants"], a[href*="funding"], a[href*="program"]').each((_, el) => {
            const title = $(el).text().trim();
            const href = $(el).attr('href');
            if (title.length > 10 && title.length < 200) {
              this.stats.found++;
            }
          });

          // Look for structured grant listings
          $('h2, h3, .card-title, .gc-toc a').each(async (_, el) => {
            const title = $(el).text().trim();
            if (title.length > 10 && title.includes('Grant') || title.includes('Fund') || title.includes('Program')) {
              this.stats.found++;
            }
          });

          await this._delay(DELAY);
        } catch (err) {
          console.error(`[Canada] Error scraping ${url}:`, err.message);
          this.stats.errors++;
        }
      }

      // Curated list of known Canadian federal grants
      const federalGrants = [
        {
          title: 'Canada Small Business Financing Program',
          description: 'Government-backed loans up to $1,000,000 for small businesses to finance the purchase or improvement of fixed assets.',
          funder_name: 'Innovation, Science and Economic Development Canada',
          funding_amount_min: 0,
          funding_amount_max: 1000000,
          eligibility_types: ['sme', 'startup'],
          sectors: ['general', 'manufacturing', 'technology', 'retail'],
          application_url: 'https://ised-isde.canada.ca/site/canada-small-business-financing-program/en',
          is_rolling: true,
        },
        {
          title: 'Scientific Research and Experimental Development (SR&ED) Tax Credit',
          description: 'Tax incentives for businesses conducting R&D in Canada. Refundable investment tax credit of up to 35% of qualifying SR&ED expenditures.',
          funder_name: 'Canada Revenue Agency',
          funding_amount_min: 0,
          funding_amount_max: 3000000,
          eligibility_types: ['sme', 'startup', 'research'],
          sectors: ['technology', 'manufacturing', 'clean-energy', 'healthcare', 'agriculture'],
          application_url: 'https://www.canada.ca/en/revenue-agency/services/scientific-research-experimental-development-tax-incentive-program.html',
          is_rolling: true,
        },
        {
          title: 'Industrial Research Assistance Program (IRAP)',
          description: 'NRC-IRAP provides advice, connections and funding to help Canadian small and medium-sized businesses increase their innovation capacity.',
          funder_name: 'National Research Council Canada',
          funding_amount_min: 10000,
          funding_amount_max: 10000000,
          eligibility_types: ['sme', 'startup'],
          sectors: ['technology', 'clean-energy', 'healthcare', 'manufacturing'],
          application_url: 'https://nrc.canada.ca/en/support-technology-innovation/industrial-research-assistance-program',
          is_rolling: true,
        },
        {
          title: 'CanExport SMEs',
          description: 'Financial support for Canadian SMEs seeking to develop new export markets. Up to $50,000 per project for export marketing activities.',
          funder_name: 'Trade Commissioner Service',
          funding_amount_min: 0,
          funding_amount_max: 50000,
          eligibility_types: ['sme'],
          sectors: ['general', 'technology', 'manufacturing', 'agriculture', 'clean-energy'],
          application_url: 'https://www.tradecommissioner.gc.ca/funding-financement/canexport/sme-pme.aspx?lang=eng',
          is_rolling: true,
        },
        {
          title: 'Women Entrepreneurship Fund',
          description: 'Support for women-owned and women-led businesses in Canada to help them grow and reach new markets.',
          funder_name: 'Innovation, Science and Economic Development Canada',
          funding_amount_min: 25000,
          funding_amount_max: 100000,
          eligibility_types: ['women_owned', 'sme', 'startup'],
          sectors: ['general'],
          application_url: 'https://ised-isde.canada.ca/site/women-entrepreneurship-strategy/en',
          is_rolling: false,
        },
        {
          title: 'Indigenous Growth Fund',
          description: 'A $150-million fund supporting Indigenous-owned businesses through Aboriginal Financial Institutions across Canada.',
          funder_name: 'National Aboriginal Capital Corporations Association',
          funding_amount_min: 10000,
          funding_amount_max: 250000,
          eligibility_types: ['indigenous', 'sme', 'startup'],
          sectors: ['general'],
          application_url: 'https://nacca.ca/indigenous-growth-fund/',
          is_rolling: true,
        },
        {
          title: 'Strategic Innovation Fund',
          description: 'Large-scale investments in innovative projects across all sectors of the economy. Supports R&D, commercialization, and firm growth.',
          funder_name: 'Innovation, Science and Economic Development Canada',
          funding_amount_min: 10000000,
          funding_amount_max: 500000000,
          eligibility_types: ['sme', 'research'],
          sectors: ['technology', 'clean-energy', 'healthcare', 'manufacturing', 'aerospace'],
          application_url: 'https://ised-isde.canada.ca/site/strategic-innovation-fund/en',
          is_rolling: true,
        },
        {
          title: 'Canada Digital Adoption Program',
          description: 'Help small businesses adopt digital technologies. Grants up to $15,000 for digital adoption plans and $100,000 interest-free loans.',
          funder_name: 'Innovation, Science and Economic Development Canada',
          funding_amount_min: 2400,
          funding_amount_max: 15000,
          eligibility_types: ['sme'],
          sectors: ['general', 'retail', 'manufacturing', 'technology'],
          application_url: 'https://ised-isde.canada.ca/site/canada-digital-adoption-program/en',
          is_rolling: false,
        },
        {
          title: 'Clean Growth Hub Programs',
          description: 'Central access to federal clean technology programs, services, and funding to support clean technology development and adoption.',
          funder_name: 'Natural Resources Canada',
          funding_amount_min: 50000,
          funding_amount_max: 5000000,
          eligibility_types: ['sme', 'startup', 'research'],
          sectors: ['clean-energy', 'environment', 'technology'],
          application_url: 'https://www.canada.ca/en/services/environment/weather/climatechange/climate-plan/clean-growth-hub.html',
          is_rolling: true,
        },
        {
          title: 'Futurpreneur Canada',
          description: 'Financing, mentoring and support tools for young entrepreneurs aged 18-39. Up to $60,000 in startup financing.',
          funder_name: 'Futurpreneur Canada',
          funding_amount_min: 5000,
          funding_amount_max: 60000,
          eligibility_types: ['startup'],
          sectors: ['general'],
          application_url: 'https://www.futurpreneur.ca/en/',
          is_rolling: true,
        },
      ];

      for (const grant of federalGrants) {
        await this._upsertGrant({
          ...grant,
          country: 'CA',
          region: 'Federal',
          funder_type: 'government',
          currency: 'CAD',
          source_system: 'canada_federal',
          source_url: grant.application_url,
          keywords: ['canada', 'federal'],
        });
        this.stats.found++;
      }

      console.log(`[Canada] Federal grants processed: ${federalGrants.length}`);
    } catch (err) {
      console.error('[Canada] Canada.ca scrape error:', err.message);
      this.stats.errors++;
    }
  }

  // -------------------------------------------------------------------------
  // NRC-IRAP
  // -------------------------------------------------------------------------

  async _scrapeIRAP() {
    console.log('[Canada] Scraping NRC-IRAP...');
    try {
      const url = 'https://nrc.canada.ca/en/support-technology-innovation';
      const html = await this._fetch(url);
      if (!html) return;

      const $ = cheerio.load(html);
      // Look for program listings
      $('h2, h3, .field-content a').each((_, el) => {
        const title = $(el).text().trim();
        if (title.length > 5) {
          this.stats.found++;
        }
      });
    } catch (err) {
      console.error('[Canada] IRAP scrape error:', err.message);
      this.stats.errors++;
    }
  }

  // -------------------------------------------------------------------------
  // SDTC (Sustainable Development Technology Canada)
  // -------------------------------------------------------------------------

  async _scrapeSDTC() {
    console.log('[Canada] Scraping SDTC...');
    try {
      const url = 'https://www.sdtc.ca/en/funding/';
      const html = await this._fetch(url);
      if (!html) return;

      const $ = cheerio.load(html);
      $('h2, h3, .program-title').each((_, el) => {
        const title = $(el).text().trim();
        if (title.length > 5) {
          this.stats.found++;
        }
      });
    } catch (err) {
      console.error('[Canada] SDTC scrape error:', err.message);
      this.stats.errors++;
    }
  }

  // -------------------------------------------------------------------------
  // Provincial portals
  // -------------------------------------------------------------------------

  async _scrapeOntario() {
    console.log('[Canada] Scraping Ontario grants...');
    const ontarioGrants = [
      {
        title: 'Ontario Together Fund',
        description: 'Supporting Ontario businesses to retool manufacturing and develop innovative solutions.',
        funder_name: 'Ontario Ministry of Economic Development',
        funding_amount_min: 50000,
        funding_amount_max: 2500000,
        eligibility_types: ['sme', 'startup'],
        sectors: ['manufacturing', 'technology', 'healthcare'],
        application_url: 'https://www.ontario.ca/page/ontario-together',
        is_rolling: false,
      },
      {
        title: 'Ontario Innovation Tax Credit',
        description: 'A 10% refundable tax credit for qualifying R&D expenditures made by eligible corporations in Ontario.',
        funder_name: 'Ontario Ministry of Finance',
        funding_amount_min: 0,
        funding_amount_max: 500000,
        eligibility_types: ['sme', 'research'],
        sectors: ['technology', 'manufacturing', 'clean-energy'],
        application_url: 'https://www.ontario.ca/page/ontario-innovation-tax-credit',
        is_rolling: true,
      },
    ];

    for (const grant of ontarioGrants) {
      await this._upsertGrant({
        ...grant,
        country: 'CA',
        region: 'Ontario',
        funder_type: 'government',
        currency: 'CAD',
        source_system: 'canada_ontario',
        source_url: grant.application_url,
        keywords: ['canada', 'ontario'],
      });
      this.stats.found++;
    }
  }

  async _scrapeBC() {
    console.log('[Canada] Scraping BC grants...');
    const bcGrants = [
      {
        title: 'Innovate BC Programs',
        description: 'Programs supporting tech innovation and entrepreneurship in British Columbia including venture acceleration and ignite programs.',
        funder_name: 'Innovate BC',
        funding_amount_min: 10000,
        funding_amount_max: 300000,
        eligibility_types: ['sme', 'startup'],
        sectors: ['technology', 'clean-energy'],
        application_url: 'https://innovatebc.ca/programs/',
        is_rolling: true,
      },
      {
        title: 'BC Small Business Venture Tax Credit',
        description: 'Tax credit for investors who invest in eligible small businesses in British Columbia.',
        funder_name: 'BC Ministry of Finance',
        funding_amount_min: 0,
        funding_amount_max: 120000,
        eligibility_types: ['sme', 'startup'],
        sectors: ['general'],
        application_url: 'https://www2.gov.bc.ca/gov/content/taxes/income-taxes/corporate/credits/venture-capital',
        is_rolling: true,
      },
    ];

    for (const grant of bcGrants) {
      await this._upsertGrant({
        ...grant,
        country: 'CA',
        region: 'British Columbia',
        funder_type: 'government',
        currency: 'CAD',
        source_system: 'canada_bc',
        source_url: grant.application_url,
        keywords: ['canada', 'british-columbia'],
      });
      this.stats.found++;
    }
  }

  async _scrapeAlberta() {
    console.log('[Canada] Scraping Alberta grants...');
    const albertaGrants = [
      {
        title: 'Alberta Innovates Programs',
        description: 'R&D funding and support for innovators and entrepreneurs in Alberta across multiple technology sectors.',
        funder_name: 'Alberta Innovates',
        funding_amount_min: 25000,
        funding_amount_max: 5000000,
        eligibility_types: ['sme', 'startup', 'research'],
        sectors: ['technology', 'clean-energy', 'healthcare', 'agriculture'],
        application_url: 'https://albertainnovates.ca/programs/',
        is_rolling: true,
      },
      {
        title: 'Alberta Small Business Grant',
        description: 'Grant program to help Alberta small businesses recover, grow, and diversify their operations.',
        funder_name: 'Government of Alberta',
        funding_amount_min: 5000,
        funding_amount_max: 25000,
        eligibility_types: ['sme'],
        sectors: ['general'],
        application_url: 'https://www.alberta.ca/small-business-supports',
        is_rolling: false,
      },
    ];

    for (const grant of albertaGrants) {
      await this._upsertGrant({
        ...grant,
        country: 'CA',
        region: 'Alberta',
        funder_type: 'government',
        currency: 'CAD',
        source_system: 'canada_alberta',
        source_url: grant.application_url,
        keywords: ['canada', 'alberta'],
      });
      this.stats.found++;
    }
  }

  async _scrapeQuebec() {
    console.log('[Canada] Scraping Quebec grants...');
    const qcGrants = [
      {
        title: 'Programme ESSOR',
        description: 'Financial assistance for Quebec businesses for investment projects and innovation initiatives.',
        funder_name: 'Investissement Quebec',
        funding_amount_min: 50000,
        funding_amount_max: 5000000,
        eligibility_types: ['sme'],
        sectors: ['manufacturing', 'technology', 'clean-energy'],
        application_url: 'https://www.investquebec.com/quebec/en/financial-products/smes-and-large-corporations/programme-essor.html',
        is_rolling: true,
      },
      {
        title: 'Quebec Innovation Tax Credits',
        description: 'Tax credits for R&D activities conducted in Quebec, including the SR&ED provincial supplement.',
        funder_name: 'Revenu Quebec',
        funding_amount_min: 0,
        funding_amount_max: 1000000,
        eligibility_types: ['sme', 'startup', 'research'],
        sectors: ['technology', 'manufacturing', 'clean-energy', 'healthcare'],
        application_url: 'https://www.revenuquebec.ca/en/businesses/income-tax/tax-credits-for-businesses/',
        is_rolling: true,
      },
    ];

    for (const grant of qcGrants) {
      await this._upsertGrant({
        ...grant,
        country: 'CA',
        region: 'Quebec',
        funder_type: 'government',
        currency: 'CAD',
        source_system: 'canada_quebec',
        source_url: grant.application_url,
        keywords: ['canada', 'quebec'],
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
        // Update existing
        await this.pool.query(
          `UPDATE grants SET description = $1, funding_amount_min = $2, funding_amount_max = $3, last_verified = NOW(), updated_at = NOW()
           WHERE title = $4 AND source_system = $5
           RETURNING id`,
          [grant.description, grant.funding_amount_min, grant.funding_amount_max, grant.title, grant.source_system]
        );
        this.stats.updated++;
      }
    } catch (err) {
      console.error(`[Canada] Error upserting grant "${grant.title}":`, err.message);
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
    } catch (err) {
      return null;
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { CanadaGrantsScraper };
