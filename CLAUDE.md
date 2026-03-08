# GrantRadar — Autonomous Build Instructions

## Project Overview
Build a global grant and non-dilutive funding intelligence platform. Continuously
scrape government portals and foundation databases worldwide. AI-match organizations
to their best funding opportunities. Serve SMEs, startups, nonprofits, and
grant consultants.

## Autonomous Agent Rules
Spawn parallel agents, no user input required, log to DEVLOG.md, commit each phase.

## Phase 1: Infrastructure (Week 1) — 3 Parallel Agents

Agent A — Backend:
  - Node.js + Express. Standard dependencies + axios for API calls.
  - /src/db/schema.sql tables:
    grants(id, title, description, funder_name, funder_type ENUM(government,
    foundation,corporation,eu,un), country, region, funding_amount_min,
    funding_amount_max, currency, deadline, is_rolling BOOL,
    eligibility_types[] ENUM(sme,startup,nonprofit,research,indigenous,
    women_owned,social_enterprise,any), sectors[], keywords[],
    application_url, source_url, source_system, last_verified, status
    ENUM(active,expired,upcoming), created_at)
    organizations(id, name, email, country, org_type, sectors[],
    employee_count, annual_revenue, founded_year, is_indigenous BOOL,
    is_women_owned BOOL, is_nonprofit BOOL, subscription_tier,
    profile_complete BOOL, created_at)
    matches(id, org_id, grant_id, score FLOAT, reasons[], viewed BOOL,
    applied BOOL, awarded BOOL, created_at)
    grant_applications(id, org_id, grant_id, status, award_amount,
    platform_success_fee, created_at)
    consultants(id, name, email, country, specializations[], client_count,
    success_rate, subscription_tier, created_at)
    scrape_jobs(id, source, country, status, found, inserted, updated,
    started_at, completed_at)

Agent B — Frontend (parallel):
  - Pages: index.html, find-grant.html, find-government-grant.html,
    find-startup-grant.html, find-nonprofit-grant.html,
    find-indigenous-grant.html, find-research-grant.html,
    for-consultants.html, organization-profile.html,
    my-matches.html, eligibility-quiz.html,
    pricing.html, how-it-works.html, grant-calendar.html,
    success-stories.html, blog.html, contact.html
  - Design: Forest green #1A7A4A primary, gold #C9A227 accent, clean white
  - find-grant.html filters: country (multi), org type (multi-select),
    sector, funding amount range slider, deadline (next 30/60/90/180 days),
    rolling vs deadline, keyword search
  - Grant cards: title, funder name + type badge, country flags,
    funding amount range, deadline countdown, eligibility tags,
    match % indicator (for logged-in users), Apply button
  - eligibility-quiz.html: 10-question wizard building org profile:
    country, org type, sector, employee count, revenue, special status
    then redirect to my-matches.html with top 10 grants
  - grant-calendar.html: visual calendar of upcoming grant deadlines,
    color-coded by sector, filterable by org type
  - my-matches.html: personalized dashboard showing AI match score,
    match reasons, deadline urgency indicator,
    Mark as Applied, Mark as Awarded tracking
  - pricing.html: SME plan $99/mo, Professional $299/mo,
    Consultant $499/mo, Enterprise $2000/mo, FAQPage JSON-LD
  - All pages: BreadcrumbList JSON-LD, sitemap.xml, robots.txt, GA4

Agent C — Railway + GitHub setup: standard.
  - railway.json, Procfile, Dockerfile
  - .github/workflows/deploy.yml
  - scripts/deploy.sh

## Phase 2: Data Ingestion (Weeks 2-3) — 5 Parallel Agents

Agent D — Grants.gov API (USA, 1000+ federal programs, FREE):
  - No auth required for basic search.
  - GET https://www.grants.gov/grantsws/rest/opportunities/search
  - Paginate through all active opportunities.
  - Extract: title, agency, synopsis, eligibility, posted_date, close_date,
    award_ceiling, award_floor, cfda_number, link
  - Map CFDA numbers to sectors array.
  - Map eligibility codes to eligibility_types array.
  - Schedule: daily refresh at 2am UTC.

Agent E — Canada grants (parallel):
  - Canada.ca business grants and financing finder — Puppeteer
  - IRAP: nrc.canada.ca/en/support-technology-innovation — Cheerio scrape
  - SDTC: sdtc.ca/en/funding — Cheerio
  - Each province: Ontario, BC, Alberta, Quebec government grant portals
  - Weekly refresh cron job.

Agent F — European Union grants (parallel):
  - EU Funding and Tenders Portal REST API:
    https://api.tech.ec.europa.eu/search-api/prod/rest/search
    No auth required. Query: ?query=SME&pageSize=100&pageNumber=1
  - Horizon Europe: separate endpoint, research-focused
  - European Structural Funds: top 8 member state portals
  - Weekly refresh.

Agent G — UK + Australia + Singapore + UAE (parallel):
  - UK: Innovate UK portal, HMRC R&D guidance gov.uk, British Business Bank
  - Australia: business.gov.au/grants-and-programs — Puppeteer
  - Singapore: edb.gov.sg, enterprisesg.gov.sg — Cheerio
  - UAE: ADIO and Dubai SME grant programs — Puppeteer

Agent H — Foundation grants (parallel):
  - Curated list of 50 major foundations: Gates, Rockefeller, Ford,
    Open Society, MacArthur, Wellcome Trust, and 44 others
  - Scrape each foundation's Current Grants or Apply page
  - Extract deadline, amount, eligibility
  - Monthly refresh

## Phase 3: AI Eligibility Matching (Week 4)
  - /src/matching/grant-scorer.js:
    Inputs: organization profile (country, org_type, sectors, employee_count,
    annual_revenue, is_indigenous, is_women_owned, is_nonprofit)
    Scoring: 30% country match, 25% org type eligibility, 25% sector overlap,
    10% size fit, 10% special status bonus
  - /src/matching/reasoning-generator.js:
    Use Claude API (claude-haiku-20240307) to generate 2-3 sentence explanation
    of why this grant matches this org. Cache result to DB, do not regenerate.
  - Nightly cron: run scorer for all active orgs x all active grants,
    update matches table, send email digest to orgs with new top matches
  - GET /api/matches?org_id= returns sorted matches with score + reasons

## Phase 4: Deadline Monitoring + Alerts (Week 5)
  - node-cron daily at 6am UTC: check grants expiring in 7, 14, 30 days
  - Email alert to all matched orgs with deadline warnings
  - Grant expiry: auto-set status=expired when deadline passes
  - Rolling grants: verify still active monthly
  - Admin alert: new grants found in last 24h summary email

## Phase 5: Payments, Auth, Admin (Week 6)
  Stripe products:
    SME Plan: $99/mo
    Professional: $299/mo
    Consultant: $499/mo (manage 10 client orgs)
    Enterprise: $2000/mo (API access, unlimited orgs)
    Success Add-on: 2% of awarded grant amount (honor system)
  Auth: JWT, bcrypt, email OTP verification — same pattern as canadainvesting-backend
  Admin: /admin/dashboard.html with grant database stats, source health,
    scraper pipeline status (port your existing admin dashboard pattern)
  Automated 6-hour digest email (port from existing report format)

## Phase 6: SEO (Week 7)
  - Country pages: canada-government-grants.html, uk-small-business-grants.html,
    australia-business-grants.html, usa-federal-grants.html — 30 pages
  - Org type pages: startup-grants.html, indigenous-business-grants.html,
    women-owned-business-grants.html, nonprofit-grants.html
  - Sector pages: cleantech-grants.html, agri-food-grants.html,
    ai-technology-grants.html, manufacturing-grants.html — 20 pages
  - Each page: live grant count badge, top 5 grants preview, CTA to see all,
    ItemList JSON-LD schema
  - FAQ JSON-LD on all major pages
  - Submit sitemap.xml to Google Search Console (user action required)

## Environment Variables (create .env.example)
DATABASE_URL
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
ANTHROPIC_API_KEY
SMTP_HOST
SMTP_USER
SMTP_PASS
JWT_SECRET
ADMIN_EMAIL
GA4_MEASUREMENT_ID
PORT
# No paid API keys required for MVP — all data sources are free

## Git Workflow
- Remote: github.com/arhurkostaras/grantradar
- Branch: main
- Commit after each phase completion
- Push immediately after commit
- Log all decisions and file changes to DEVLOG.md
