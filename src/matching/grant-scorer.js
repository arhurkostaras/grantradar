// src/matching/grant-scorer.js — AI Grant Eligibility Scorer
// Scores organization-grant pairs based on weighted criteria:
// 30% country match, 25% org type eligibility, 25% sector overlap,
// 10% size fit, 10% special status bonus

class GrantScorer {
  constructor(pool) {
    this.pool = pool;
    this.stats = { orgsProcessed: 0, grantsScored: 0, matchesCreated: 0, matchesUpdated: 0 };
  }

  /**
   * Run matching for all active organizations against all active grants.
   * Called by nightly cron at 1am UTC.
   */
  async runFullMatching() {
    console.log('[Scorer] Starting full matching run...');
    this.stats = { orgsProcessed: 0, grantsScored: 0, matchesCreated: 0, matchesUpdated: 0 };

    try {
      // Get all active organizations with profiles
      const orgsResult = await this.pool.query(
        `SELECT id, name, country, org_type, sectors, employee_count, annual_revenue,
                founded_year, is_indigenous, is_women_owned, is_nonprofit
         FROM organizations
         WHERE profile_complete = true OR (country IS NOT NULL AND org_type IS NOT NULL)
         ORDER BY created_at DESC`
      );

      // Get all active grants
      const grantsResult = await this.pool.query(
        `SELECT id, title, country, funder_type, eligibility_types, sectors,
                funding_amount_min, funding_amount_max, deadline, is_rolling
         FROM grants
         WHERE status = 'active'
         ORDER BY created_at DESC`
      );

      const orgs = orgsResult.rows;
      const grants = grantsResult.rows;

      console.log(`[Scorer] Processing ${orgs.length} orgs x ${grants.length} grants = ${orgs.length * grants.length} pairs`);

      for (const org of orgs) {
        let orgMatches = 0;

        for (const grant of grants) {
          const result = this.scoreMatch(org, grant);

          if (result.score >= 0.3) { // Minimum 30% match threshold
            await this._upsertMatch(org.id, grant.id, result.score, result.reasons);
            orgMatches++;
            this.stats.grantsScored++;
          }
        }

        this.stats.orgsProcessed++;
        if (this.stats.orgsProcessed % 10 === 0) {
          console.log(`[Scorer] Progress: ${this.stats.orgsProcessed}/${orgs.length} orgs, ${this.stats.grantsScored} matches found`);
        }
      }

      console.log(`[Scorer] Complete — ${this.stats.orgsProcessed} orgs, ${this.stats.grantsScored} scored, ${this.stats.matchesCreated} created, ${this.stats.matchesUpdated} updated`);
    } catch (err) {
      console.error('[Scorer] Fatal error:', err.message);
    }

    return this.stats;
  }

  /**
   * Run matching for a single organization (e.g., after profile update or quiz).
   * Returns top matches sorted by score.
   */
  async scoreForOrganization(orgId, limit = 50) {
    const orgResult = await this.pool.query(
      `SELECT id, name, country, org_type, sectors, employee_count, annual_revenue,
              founded_year, is_indigenous, is_women_owned, is_nonprofit
       FROM organizations WHERE id = $1`,
      [orgId]
    );

    if (orgResult.rows.length === 0) {
      throw new Error('Organization not found');
    }

    const org = orgResult.rows[0];

    const grantsResult = await this.pool.query(
      `SELECT id, title, country, funder_type, eligibility_types, sectors,
              funding_amount_min, funding_amount_max, deadline, is_rolling
       FROM grants
       WHERE status = 'active'
       ORDER BY created_at DESC`
    );

    const matches = [];

    for (const grant of grantsResult.rows) {
      const result = this.scoreMatch(org, grant);
      if (result.score >= 0.2) { // Lower threshold for individual queries
        matches.push({
          grant_id: grant.id,
          score: result.score,
          reasons: result.reasons,
        });

        // Upsert match record
        await this._upsertMatch(org.id, grant.id, result.score, result.reasons);
      }
    }

    // Sort by score descending and limit
    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, limit);
  }

  /**
   * Core scoring algorithm.
   * Returns { score: 0-1, reasons: string[] }
   */
  scoreMatch(org, grant) {
    let totalScore = 0;
    const reasons = [];

    // --- 1. Country Match (30%) ---
    const countryScore = this._scoreCountry(org, grant);
    totalScore += countryScore * 0.30;
    if (countryScore >= 0.8) {
      reasons.push(`Available in your country (${org.country})`);
    } else if (countryScore >= 0.5) {
      reasons.push('Available in your region');
    }

    // --- 2. Organization Type Eligibility (25%) ---
    const eligibilityScore = this._scoreEligibility(org, grant);
    totalScore += eligibilityScore * 0.25;
    if (eligibilityScore >= 0.8) {
      reasons.push(`Matches your organization type (${org.org_type})`);
    }

    // --- 3. Sector Overlap (25%) ---
    const sectorScore = this._scoreSectors(org, grant);
    totalScore += sectorScore * 0.25;
    if (sectorScore >= 0.5) {
      const overlap = this._getSectorOverlap(org.sectors, grant.sectors);
      if (overlap.length > 0) {
        reasons.push(`Sector match: ${overlap.slice(0, 3).join(', ')}`);
      }
    }

    // --- 4. Size Fit (10%) ---
    const sizeScore = this._scoreSizeFit(org, grant);
    totalScore += sizeScore * 0.10;
    if (sizeScore >= 0.7) {
      reasons.push('Funding range fits your organization size');
    }

    // --- 5. Special Status Bonus (10%) ---
    const statusScore = this._scoreSpecialStatus(org, grant);
    totalScore += statusScore * 0.10;
    if (statusScore > 0) {
      if (org.is_indigenous && this._grantSupportsEligibility(grant, 'indigenous')) {
        reasons.push('Indigenous business priority');
      }
      if (org.is_women_owned && this._grantSupportsEligibility(grant, 'women_owned')) {
        reasons.push('Women-owned business priority');
      }
      if (org.is_nonprofit && this._grantSupportsEligibility(grant, 'nonprofit')) {
        reasons.push('Nonprofit organization eligible');
      }
    }

    // Deadline urgency bonus reason
    if (grant.deadline) {
      const daysUntil = Math.ceil((new Date(grant.deadline) - new Date()) / (1000 * 60 * 60 * 24));
      if (daysUntil > 0 && daysUntil <= 30) {
        reasons.push(`Deadline in ${daysUntil} days — apply soon!`);
      } else if (daysUntil > 30 && daysUntil <= 90) {
        reasons.push(`Deadline in ${daysUntil} days`);
      }
    } else if (grant.is_rolling) {
      reasons.push('Rolling deadline — apply anytime');
    }

    return {
      score: Math.round(totalScore * 100) / 100,
      reasons,
    };
  }

  // -------------------------------------------------------------------------
  // Scoring Components
  // -------------------------------------------------------------------------

  _scoreCountry(org, grant) {
    if (!org.country || !grant.country) return 0.3; // Unknown = partial match

    const orgCountry = org.country.toUpperCase();
    const grantCountry = grant.country.toUpperCase();

    // Exact match
    if (orgCountry === grantCountry) return 1.0;

    // Global grants match everyone
    if (grantCountry === 'GLOBAL') return 0.9;

    // EU grants match EU member states
    if (grantCountry === 'EU') {
      const euCountries = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
      if (euCountries.includes(orgCountry)) return 0.9;
      // EEA/associated countries
      if (['NO', 'IS', 'LI', 'CH', 'UK', 'IL', 'TR'].includes(orgCountry)) return 0.5;
      return 0.2;
    }

    // Same region bonus
    const regions = {
      'NORTH_AMERICA': ['US', 'CA', 'MX'],
      'EUROPE': ['UK', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'SE', 'NO', 'DK', 'FI', 'IE', 'AT', 'CH', 'PL', 'CZ', 'PT'],
      'ASIA_PACIFIC': ['AU', 'NZ', 'SG', 'HK', 'JP', 'KR', 'IN'],
      'MIDDLE_EAST': ['AE', 'SA', 'QA', 'BH', 'KW', 'OM', 'IL'],
    };

    for (const [, countries] of Object.entries(regions)) {
      if (countries.includes(orgCountry) && countries.includes(grantCountry)) {
        return 0.3;
      }
    }

    return 0.1;
  }

  _scoreEligibility(org, grant) {
    if (!grant.eligibility_types || grant.eligibility_types.length === 0) return 0.5;

    const grantElig = Array.isArray(grant.eligibility_types)
      ? grant.eligibility_types
      : (typeof grant.eligibility_types === 'string' ? grant.eligibility_types.replace(/[{}]/g, '').split(',') : []);

    // 'any' means universal eligibility
    if (grantElig.includes('any')) return 0.8;

    const orgType = (org.org_type || '').toLowerCase();

    // Map org types to eligibility types
    const orgEligMap = {
      'sme': 'sme',
      'small business': 'sme',
      'medium business': 'sme',
      'startup': 'startup',
      'nonprofit': 'nonprofit',
      'non-profit': 'nonprofit',
      'charity': 'nonprofit',
      'research': 'research',
      'university': 'research',
      'social enterprise': 'social_enterprise',
      'social_enterprise': 'social_enterprise',
    };

    const mappedType = orgEligMap[orgType] || orgType;

    if (grantElig.includes(mappedType)) return 1.0;

    // Check special statuses
    if (org.is_indigenous && grantElig.includes('indigenous')) return 1.0;
    if (org.is_women_owned && grantElig.includes('women_owned')) return 1.0;
    if (org.is_nonprofit && grantElig.includes('nonprofit')) return 1.0;

    // SME is broad — startups often qualify
    if (mappedType === 'startup' && grantElig.includes('sme')) return 0.7;
    if (mappedType === 'sme' && grantElig.includes('startup')) return 0.5;

    return 0.2;
  }

  _scoreSectors(org, grant) {
    const orgSectors = this._parseSectors(org.sectors);
    const grantSectors = this._parseSectors(grant.sectors);

    if (orgSectors.length === 0 || grantSectors.length === 0) return 0.3;

    // Check for 'general' which matches everything
    if (grantSectors.includes('general')) return 0.6;

    const overlap = this._getSectorOverlap(orgSectors, grantSectors);
    if (overlap.length === 0) return 0.1;

    // Score based on overlap ratio
    const overlapRatio = overlap.length / Math.min(orgSectors.length, grantSectors.length);
    return Math.min(1.0, 0.3 + overlapRatio * 0.7);
  }

  _scoreSizeFit(org, grant) {
    // If no funding range specified, neutral score
    if (!grant.funding_amount_max && !grant.funding_amount_min) return 0.5;

    const revenue = org.annual_revenue || 0;
    const employees = org.employee_count || 0;
    const maxFunding = grant.funding_amount_max || Infinity;
    const minFunding = grant.funding_amount_min || 0;

    // Micro businesses (< 10 employees) — best fit for small grants
    if (employees < 10) {
      if (maxFunding <= 100000) return 1.0;
      if (maxFunding <= 500000) return 0.8;
      if (maxFunding <= 2000000) return 0.6;
      return 0.3; // Very large grants less likely for micro
    }

    // Small businesses (10-50 employees)
    if (employees <= 50) {
      if (maxFunding >= 25000 && maxFunding <= 2000000) return 1.0;
      if (maxFunding <= 10000000) return 0.7;
      return 0.4;
    }

    // Medium businesses (51-200 employees)
    if (employees <= 200) {
      if (maxFunding >= 100000 && maxFunding <= 10000000) return 1.0;
      if (maxFunding > 10000000) return 0.7;
      return 0.4;
    }

    // Larger businesses (200+)
    if (maxFunding >= 500000) return 0.8;
    return 0.3;
  }

  _scoreSpecialStatus(org, grant) {
    let bonus = 0;

    if (org.is_indigenous && this._grantSupportsEligibility(grant, 'indigenous')) {
      bonus += 0.5;
    }
    if (org.is_women_owned && this._grantSupportsEligibility(grant, 'women_owned')) {
      bonus += 0.5;
    }
    if (org.is_nonprofit && this._grantSupportsEligibility(grant, 'nonprofit')) {
      bonus += 0.3;
    }

    // Social enterprise bonus
    const orgType = (org.org_type || '').toLowerCase();
    if ((orgType === 'social enterprise' || orgType === 'social_enterprise') &&
        this._grantSupportsEligibility(grant, 'social_enterprise')) {
      bonus += 0.3;
    }

    return Math.min(1.0, bonus);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  _grantSupportsEligibility(grant, type) {
    const eligTypes = this._parseSectors(grant.eligibility_types);
    return eligTypes.includes(type) || eligTypes.includes('any');
  }

  _parseSectors(sectors) {
    if (!sectors) return [];
    if (Array.isArray(sectors)) return sectors.map(s => s.toLowerCase().trim()).filter(Boolean);
    if (typeof sectors === 'string') {
      return sectors.replace(/[{}"\[\]]/g, '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    return [];
  }

  _getSectorOverlap(sectors1, sectors2) {
    const set1 = this._parseSectors(sectors1);
    const set2 = this._parseSectors(sectors2);
    return set1.filter(s => set2.includes(s));
  }

  async _upsertMatch(orgId, grantId, score, reasons) {
    try {
      const result = await this.pool.query(
        `INSERT INTO matches (org_id, grant_id, score, reasons)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, grant_id) DO UPDATE SET score = $3, reasons = $4, updated_at = NOW()
         RETURNING id`,
        [orgId, grantId, score, `{${reasons.map(r => `"${r.replace(/"/g, '\\"')}"`).join(',')}}`]
      );

      if (result.command === 'INSERT') {
        this.stats.matchesCreated++;
      } else {
        this.stats.matchesUpdated++;
      }
    } catch (err) {
      // Silently skip duplicate errors
      if (!err.message.includes('duplicate')) {
        console.error(`[Scorer] Error upserting match:`, err.message);
      }
    }
  }
}

module.exports = { GrantScorer };
