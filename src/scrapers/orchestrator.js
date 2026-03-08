// src/scrapers/orchestrator.js — Scraper Orchestrator
// Coordinates all grant scrapers, provides unified trigger/status/stats API
const { GrantsGovScraper } = require('./grants-gov');
const { CanadaGrantsScraper } = require('./canada');
const { EUGrantsScraper } = require('./eu');
const { InternationalGrantsScraper } = require('./international');
const { FoundationGrantsScraper } = require('./foundations');

const SOURCES = ['grants_gov', 'canada', 'eu', 'uk', 'au', 'sg', 'uae', 'international', 'foundations'];

class ScraperOrchestrator {
  constructor(pool) {
    this.pool = pool;
    this.scrapers = {
      grants_gov: new GrantsGovScraper(pool),
      canada: new CanadaGrantsScraper(pool),
      eu: new EUGrantsScraper(pool),
      international: new InternationalGrantsScraper(pool),
      foundations: new FoundationGrantsScraper(pool),
    };
    this.running = {};
  }

  /**
   * Trigger a specific scraper by source name.
   */
  async trigger(source) {
    if (this.running[source]) {
      return { error: `${source} scraper is already running` };
    }

    console.log(`[Orchestrator] Triggering ${source} scraper...`);
    this.running[source] = true;

    try {
      let result;

      switch (source) {
        case 'grants_gov':
          result = await this.scrapers.grants_gov.scrape();
          break;
        case 'canada':
          result = await this.scrapers.canada.scrape();
          break;
        case 'eu':
          result = await this.scrapers.eu.scrape();
          break;
        case 'uk':
          result = await this.scrapers.international.scrape('UK');
          break;
        case 'au':
          result = await this.scrapers.international.scrape('AU');
          break;
        case 'sg':
          result = await this.scrapers.international.scrape('SG');
          break;
        case 'uae':
          result = await this.scrapers.international.scrape('UAE');
          break;
        case 'international':
          result = await this.scrapers.international.scrape('all');
          break;
        case 'foundations':
          result = await this.scrapers.foundations.scrape();
          break;
        default:
          return { error: `Unknown source: ${source}. Valid: ${SOURCES.join(', ')}` };
      }

      console.log(`[Orchestrator] ${source} complete:`, result);
      return { source, status: 'completed', ...result };
    } catch (err) {
      console.error(`[Orchestrator] ${source} error:`, err.message);
      return { source, status: 'failed', error: err.message };
    } finally {
      this.running[source] = false;
    }
  }

  /**
   * Trigger all scrapers sequentially.
   */
  async triggerAll() {
    console.log('[Orchestrator] Triggering ALL scrapers...');
    const results = {};

    for (const source of ['grants_gov', 'canada', 'eu', 'international', 'foundations']) {
      results[source] = await this.trigger(source);
    }

    console.log('[Orchestrator] All scrapers complete');
    return results;
  }

  /**
   * Get status of all running scrapers.
   */
  async getStatus() {
    const jobs = await this.pool.query(
      `SELECT source, status, records_found, records_inserted, records_updated, error_message, started_at, completed_at
       FROM scrape_jobs
       WHERE started_at > NOW() - INTERVAL '24 hours'
       ORDER BY started_at DESC`
    );

    const runningNow = Object.keys(this.running).filter(k => this.running[k]);

    return {
      running: runningNow,
      recent_jobs: jobs.rows,
    };
  }

  /**
   * Get stats per source.
   */
  async getStats() {
    const stats = await this.pool.query(
      `SELECT source_system as source,
              COUNT(*) as total_grants,
              COUNT(*) FILTER (WHERE status = 'active') as active_grants,
              COUNT(*) FILTER (WHERE status = 'expired') as expired_grants,
              MAX(last_verified) as last_verified,
              MAX(created_at) as last_scraped
       FROM grants
       GROUP BY source_system
       ORDER BY total_grants DESC`
    );

    const totalResult = await this.pool.query(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE status = 'active') as active,
              COUNT(*) FILTER (WHERE status = 'expired') as expired,
              COUNT(*) FILTER (WHERE status = 'upcoming') as upcoming
       FROM grants`
    );

    return {
      by_source: stats.rows,
      totals: totalResult.rows[0],
    };
  }

  /**
   * Get list of valid source names.
   */
  getSources() {
    return SOURCES;
  }
}

module.exports = { ScraperOrchestrator };
