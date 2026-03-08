-- GrantRadar Database Schema
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TYPE funder_type AS ENUM ('government', 'foundation', 'corporation', 'eu', 'un');
CREATE TYPE grant_status AS ENUM ('active', 'expired', 'upcoming');
CREATE TYPE eligibility_type AS ENUM ('sme', 'startup', 'nonprofit', 'research', 'indigenous', 'women_owned', 'social_enterprise', 'any');

CREATE TABLE grants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  description TEXT,
  funder_name TEXT,
  funder_type funder_type,
  country TEXT,
  region TEXT,
  funding_amount_min NUMERIC,
  funding_amount_max NUMERIC,
  currency TEXT DEFAULT 'CAD',
  deadline TIMESTAMP,
  is_rolling BOOLEAN DEFAULT false,
  eligibility_types eligibility_type[] DEFAULT '{}',
  sectors TEXT[] DEFAULT '{}',
  keywords TEXT[] DEFAULT '{}',
  application_url TEXT,
  source_url TEXT,
  source_system TEXT,
  last_verified TIMESTAMP DEFAULT NOW(),
  status grant_status DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT,
  country TEXT,
  org_type TEXT,
  sectors TEXT[] DEFAULT '{}',
  employee_count INTEGER,
  annual_revenue NUMERIC,
  founded_year INTEGER,
  is_indigenous BOOLEAN DEFAULT false,
  is_women_owned BOOLEAN DEFAULT false,
  is_nonprofit BOOLEAN DEFAULT false,
  subscription_tier TEXT DEFAULT 'free',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  profile_complete BOOLEAN DEFAULT false,
  email_verified BOOLEAN DEFAULT false,
  verification_token TEXT,
  reset_token TEXT,
  reset_token_expires TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE matches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  grant_id UUID REFERENCES grants(id) ON DELETE CASCADE,
  score FLOAT NOT NULL DEFAULT 0,
  reasons TEXT[] DEFAULT '{}',
  ai_explanation TEXT,
  viewed BOOLEAN DEFAULT false,
  applied BOOLEAN DEFAULT false,
  awarded BOOLEAN DEFAULT false,
  award_amount NUMERIC,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(org_id, grant_id)
);

CREATE TABLE grant_applications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  grant_id UUID REFERENCES grants(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'applied',
  award_amount NUMERIC,
  platform_success_fee NUMERIC,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE consultants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT,
  country TEXT,
  specializations TEXT[] DEFAULT '{}',
  client_count INTEGER DEFAULT 0,
  success_rate FLOAT DEFAULT 0,
  subscription_tier TEXT DEFAULT 'free',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  email_verified BOOLEAN DEFAULT false,
  verification_token TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE consultant_clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  consultant_id UUID REFERENCES consultants(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(consultant_id, org_id)
);

CREATE TABLE scrape_jobs (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  country TEXT,
  status TEXT DEFAULT 'pending',
  records_found INTEGER DEFAULT 0,
  records_inserted INTEGER DEFAULT 0,
  records_updated INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE TABLE email_queue (
  id SERIAL PRIMARY KEY,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  sent_at TIMESTAMP,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE admin_users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE unsubscribes (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_grants_country ON grants(country);
CREATE INDEX idx_grants_status ON grants(status);
CREATE INDEX idx_grants_deadline ON grants(deadline);
CREATE INDEX idx_grants_funder_type ON grants(funder_type);
CREATE INDEX idx_grants_source_system ON grants(source_system);
CREATE INDEX idx_organizations_email ON organizations(email);
CREATE INDEX idx_matches_org_id ON matches(org_id);
CREATE INDEX idx_matches_grant_id ON matches(grant_id);
CREATE INDEX idx_matches_score ON matches(score DESC);
CREATE INDEX idx_scrape_jobs_source ON scrape_jobs(source);
CREATE INDEX idx_email_queue_status ON email_queue(status);
