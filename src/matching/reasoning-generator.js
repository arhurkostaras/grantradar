// src/matching/reasoning-generator.js — AI-powered match reasoning
// Uses Claude API to generate 2-3 sentence explanations of why a grant matches an org.
// Results are cached in the matches table (ai_explanation column) — never regenerated.

const Anthropic = require('@anthropic-ai/sdk');

class ReasoningGenerator {
  constructor(pool) {
    this.pool = pool;
    this.client = null;
    this.stats = { generated: 0, cached: 0, errors: 0 };
  }

  _getClient() {
    if (!this.client && process.env.ANTHROPIC_API_KEY) {
      this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return this.client;
  }

  /**
   * Generate AI explanations for top matches missing explanations.
   * Called by nightly cron after scoring run.
   */
  async generateBatchExplanations(limit = 100) {
    console.log('[Reasoning] Starting batch explanation generation...');
    this.stats = { generated: 0, cached: 0, errors: 0 };

    const client = this._getClient();
    if (!client) {
      console.log('[Reasoning] No ANTHROPIC_API_KEY configured, skipping');
      return this.stats;
    }

    try {
      // Get top matches without explanations
      const matchesResult = await this.pool.query(
        `SELECT m.id, m.org_id, m.grant_id, m.score, m.reasons,
                o.name as org_name, o.country as org_country, o.org_type,
                o.sectors as org_sectors, o.employee_count, o.is_indigenous,
                o.is_women_owned, o.is_nonprofit,
                g.title as grant_title, g.description as grant_description,
                g.funder_name, g.country as grant_country, g.funding_amount_min,
                g.funding_amount_max, g.currency, g.deadline, g.eligibility_types,
                g.sectors as grant_sectors
         FROM matches m
         JOIN organizations o ON m.org_id = o.id
         JOIN grants g ON m.grant_id = g.id
         WHERE m.ai_explanation IS NULL
           AND m.score >= 0.5
         ORDER BY m.score DESC
         LIMIT $1`,
        [limit]
      );

      console.log(`[Reasoning] ${matchesResult.rows.length} matches need explanations`);

      for (const match of matchesResult.rows) {
        try {
          const explanation = await this._generateExplanation(match);
          if (explanation) {
            await this.pool.query(
              `UPDATE matches SET ai_explanation = $1, updated_at = NOW() WHERE id = $2`,
              [explanation, match.id]
            );
            this.stats.generated++;
          }

          // Rate limit: 0.5s between API calls
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          console.error(`[Reasoning] Error generating for match ${match.id}:`, err.message);
          this.stats.errors++;
        }
      }

      console.log(`[Reasoning] Complete — Generated: ${this.stats.generated}, Errors: ${this.stats.errors}`);
    } catch (err) {
      console.error('[Reasoning] Fatal error:', err.message);
    }

    return this.stats;
  }

  /**
   * Generate explanation for a single match.
   * Checks cache first, generates only if missing.
   */
  async getExplanation(matchId) {
    // Check cache
    const cached = await this.pool.query(
      `SELECT ai_explanation FROM matches WHERE id = $1 AND ai_explanation IS NOT NULL`,
      [matchId]
    );

    if (cached.rows.length > 0) {
      this.stats.cached++;
      return cached.rows[0].ai_explanation;
    }

    // Get full match data
    const matchResult = await this.pool.query(
      `SELECT m.id, m.org_id, m.grant_id, m.score, m.reasons,
              o.name as org_name, o.country as org_country, o.org_type,
              o.sectors as org_sectors, o.employee_count, o.is_indigenous,
              o.is_women_owned, o.is_nonprofit,
              g.title as grant_title, g.description as grant_description,
              g.funder_name, g.country as grant_country, g.funding_amount_min,
              g.funding_amount_max, g.currency, g.deadline, g.eligibility_types,
              g.sectors as grant_sectors
       FROM matches m
       JOIN organizations o ON m.org_id = o.id
       JOIN grants g ON m.grant_id = g.id
       WHERE m.id = $1`,
      [matchId]
    );

    if (matchResult.rows.length === 0) return null;

    const explanation = await this._generateExplanation(matchResult.rows[0]);
    if (explanation) {
      await this.pool.query(
        `UPDATE matches SET ai_explanation = $1, updated_at = NOW() WHERE id = $2`,
        [explanation, matchId]
      );
      this.stats.generated++;
    }

    return explanation;
  }

  /**
   * Call Claude API to generate a match explanation.
   */
  async _generateExplanation(match) {
    const client = this._getClient();
    if (!client) return null;

    const fundingRange = match.funding_amount_max
      ? `${match.currency || 'USD'} ${(match.funding_amount_min || 0).toLocaleString()} - ${match.funding_amount_max.toLocaleString()}`
      : 'Not specified';

    const deadline = match.deadline
      ? new Date(match.deadline).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'Rolling / Not specified';

    const orgTraits = [];
    if (match.is_indigenous) orgTraits.push('Indigenous-owned');
    if (match.is_women_owned) orgTraits.push('Women-owned');
    if (match.is_nonprofit) orgTraits.push('Nonprofit');

    const prompt = `You are a grant advisor. In exactly 2-3 sentences, explain why this grant is a good match for this organization. Be specific and actionable. Do not use generic language.

Organization: ${match.org_name}
- Country: ${match.org_country}
- Type: ${match.org_type}
- Sectors: ${Array.isArray(match.org_sectors) ? match.org_sectors.join(', ') : match.org_sectors}
- Employees: ${match.employee_count || 'Not specified'}
${orgTraits.length > 0 ? `- Special status: ${orgTraits.join(', ')}` : ''}

Grant: ${match.grant_title}
- Funder: ${match.funder_name}
- Country: ${match.grant_country}
- Funding: ${fundingRange}
- Deadline: ${deadline}
- Description: ${(match.grant_description || '').substring(0, 300)}

Match score: ${Math.round(match.score * 100)}%
Match reasons: ${Array.isArray(match.reasons) ? match.reasons.join('; ') : match.reasons}

Write 2-3 sentences explaining why this is a strong match. Focus on the specific alignment between the organization and grant requirements.`;

    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0]?.text || '';
      return text.trim();
    } catch (err) {
      console.error('[Reasoning] Claude API error:', err.message);
      this.stats.errors++;
      return null;
    }
  }
}

module.exports = { ReasoningGenerator };
