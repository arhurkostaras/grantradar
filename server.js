require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const cron = require('node-cron');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
const {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendMatchDigest,
  sendDeadlineAlert,
  sendAdminAlert,
  sendContactFormEmail,
} = require('./services/email');
const { ScraperOrchestrator } = require('./src/scrapers/orchestrator');
const { GrantScorer } = require('./src/matching/grant-scorer');
const { ReasoningGenerator } = require('./src/matching/reasoning-generator');
const { DeadlineMonitor } = require('./src/monitoring/deadline-monitor');
const { GrantEnricher } = require('./src/enrichment/grant-enricher');

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://grantradar.com';
const BACKEND_URL = process.env.BACKEND_URL || 'https://grantradar-backend-production.up.railway.app';
const JWT_SECRET = process.env.JWT_SECRET || 'grantradar_jwt_secret_2026';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'arthur@negotiateandwin.com';

// Stripe price IDs
const STRIPE_PRICES = {
  sme: process.env.STRIPE_PRICE_SME || '',
  professional: process.env.STRIPE_PRICE_PROFESSIONAL || '',
  consultant: process.env.STRIPE_PRICE_CONSULTANT || '',
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE || '',
};

// =====================================================
// STRIPE WEBHOOK — must be before express.json()
// =====================================================

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret || !sig) {
    return res.status(400).json({ error: 'Missing webhook secret or signature' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const orgId = session.metadata?.org_id;
        const consultantId = session.metadata?.consultant_id;
        const planType = session.metadata?.plan_type;

        if (orgId && session.subscription) {
          await pool.query(
            `UPDATE organizations SET subscription_tier = $1, stripe_subscription_id = $2, stripe_customer_id = $3, updated_at = NOW() WHERE id = $4`,
            [planType, session.subscription, session.customer, orgId]
          );
          console.log(`Checkout completed for org ${orgId}, plan: ${planType}`);
        } else if (consultantId && session.subscription) {
          await pool.query(
            `UPDATE consultants SET subscription_tier = $1, stripe_subscription_id = $2, stripe_customer_id = $3, updated_at = NOW() WHERE id = $4`,
            [planType, session.subscription, session.customer, consultantId]
          );
          console.log(`Checkout completed for consultant ${consultantId}, plan: ${planType}`);
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const status = sub.status === 'active' ? 'active' : sub.status;
        // Update org
        const orgResult = await pool.query(
          `UPDATE organizations SET subscription_tier = CASE WHEN $1 != 'active' THEN 'free' ELSE subscription_tier END, updated_at = NOW() WHERE stripe_subscription_id = $2 RETURNING id`,
          [status, sub.id]
        );
        // Update consultant if not found as org
        if (orgResult.rowCount === 0) {
          await pool.query(
            `UPDATE consultants SET subscription_tier = CASE WHEN $1 != 'active' THEN 'free' ELSE subscription_tier END, updated_at = NOW() WHERE stripe_subscription_id = $2`,
            [status, sub.id]
          );
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await pool.query(
          `UPDATE organizations SET subscription_tier = 'free', stripe_subscription_id = NULL, updated_at = NOW() WHERE stripe_subscription_id = $1`,
          [sub.id]
        );
        await pool.query(
          `UPDATE consultants SET subscription_tier = 'free', stripe_subscription_id = NULL, updated_at = NOW() WHERE stripe_subscription_id = $1`,
          [sub.id]
        );
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          console.log(`Payment failed for subscription ${invoice.subscription}`);
          await sendAdminAlert('Payment Failed', `Subscription ${invoice.subscription} has a failed payment.`);
        }
        break;
      }
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// =====================================================
// CORS Configuration
// =====================================================

app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// JSON parsing middleware
app.use(express.json());

// =====================================================
// RATE LIMITING
// =====================================================

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many authentication attempts' }
});
app.use('/api/auth', authLimiter);

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many submissions, please try again later' }
});
app.use('/api/contact', contactLimiter);

// =====================================================
// DATABASE CONNECTION
// =====================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize scraper orchestrator and matching engine
const scraperOrchestrator = new ScraperOrchestrator(pool);
const grantScorer = new GrantScorer(pool);
const reasoningGenerator = new ReasoningGenerator(pool);
const grantEnricher = new GrantEnricher(pool);

// =====================================================
// JWT MIDDLEWARE
// =====================================================

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Admin authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid admin token' });
  }
}

// =====================================================
// HEALTH CHECK
// =====================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'grantradar-backend', timestamp: new Date().toISOString() });
});

// =====================================================
// AUTH ROUTES — Organization
// =====================================================

app.post('/api/auth/register', async (req, res) => {
  try {
    const {
      name, email, password, country, org_type, sectors,
      employee_count, annual_revenue, founded_year,
      is_indigenous, is_women_owned, is_nonprofit
    } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    // Check for existing email
    const existing = await pool.query('SELECT id FROM organizations WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An organization with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const profileComplete = !!(country && org_type && sectors && sectors.length > 0);

    const result = await pool.query(
      `INSERT INTO organizations (name, email, password_hash, country, org_type, sectors, employee_count, annual_revenue, founded_year, is_indigenous, is_women_owned, is_nonprofit, verification_token, profile_complete)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id, name, email, country, org_type, subscription_tier, created_at`,
      [name, email, passwordHash, country || null, org_type || null, sectors || '{}', employee_count || null, annual_revenue || null, founded_year || null, is_indigenous || false, is_women_owned || false, is_nonprofit || false, verificationToken, profileComplete]
    );

    const org = result.rows[0];
    const token = jwt.sign({ id: org.id, email: org.email, role: 'org' }, JWT_SECRET, { expiresIn: '7d' });

    // Send verification email
    try {
      await sendVerificationEmail(email, verificationToken);
    } catch (emailErr) {
      console.error('Failed to send verification email:', emailErr.message);
    }

    res.status(201).json({
      token,
      organization: org,
      message: 'Registration successful. Please check your email to verify your account.'
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, name, country, org_type, subscription_tier, email_verified FROM organizations WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const org = result.rows[0];
    const validPassword = await bcrypt.compare(password, org.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: org.id, email: org.email, role: 'org' }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      organization: {
        id: org.id,
        email: org.email,
        name: org.name,
        country: org.country,
        org_type: org.org_type,
        subscription_tier: org.subscription_tier,
        email_verified: org.email_verified
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Verification token is required' });

    const result = await pool.query(
      'UPDATE organizations SET email_verified = true, verification_token = NULL, updated_at = NOW() WHERE verification_token = $1 RETURNING id, email',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    res.json({ message: 'Email verified successfully', email: result.rows[0].email });
  } catch (err) {
    console.error('Email verification error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const result = await pool.query('SELECT id, email FROM organizations WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      // Don't reveal whether email exists
      return res.json({ message: 'If an account with that email exists, a password reset link has been sent.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 3600000); // 1 hour

    await pool.query(
      'UPDATE organizations SET reset_token = $1, reset_token_expires = $2, updated_at = NOW() WHERE email = $3',
      [resetToken, resetExpires, email]
    );

    try {
      await sendPasswordResetEmail(email, resetToken);
    } catch (emailErr) {
      console.error('Failed to send reset email:', emailErr.message);
    }

    res.json({ message: 'If an account with that email exists, a password reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Request failed' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });

    const result = await pool.query(
      'SELECT id, email FROM organizations WHERE reset_token = $1 AND reset_token_expires > NOW()',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      'UPDATE organizations SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL, updated_at = NOW() WHERE id = $2',
      [passwordHash, result.rows[0].id]
    );

    res.json({ message: 'Password has been reset successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// =====================================================
// CONSULTANT AUTH ROUTES
// =====================================================

app.post('/api/consultants/register', async (req, res) => {
  try {
    const { name, email, password, country, specializations } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    const existing = await pool.query('SELECT id FROM consultants WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A consultant with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    const result = await pool.query(
      `INSERT INTO consultants (name, email, password_hash, country, specializations, verification_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, email, country, specializations, subscription_tier, created_at`,
      [name, email, passwordHash, country || null, specializations || '{}', verificationToken]
    );

    const consultant = result.rows[0];
    const token = jwt.sign({ id: consultant.id, email: consultant.email, role: 'consultant' }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      token,
      consultant,
      message: 'Consultant registration successful.'
    });
  } catch (err) {
    console.error('Consultant registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/consultants/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, name, country, specializations, subscription_tier, client_count, success_rate FROM consultants WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const consultant = result.rows[0];
    const validPassword = await bcrypt.compare(password, consultant.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: consultant.id, email: consultant.email, role: 'consultant' }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      consultant: {
        id: consultant.id,
        email: consultant.email,
        name: consultant.name,
        country: consultant.country,
        specializations: consultant.specializations,
        subscription_tier: consultant.subscription_tier,
        client_count: consultant.client_count,
        success_rate: consultant.success_rate
      }
    });
  } catch (err) {
    console.error('Consultant login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/consultants/clients', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'consultant') {
      return res.status(403).json({ error: 'Consultant access required' });
    }

    const result = await pool.query(
      `SELECT o.id, o.name, o.email, o.country, o.org_type, o.sectors, o.employee_count, o.subscription_tier, cc.created_at as linked_at
       FROM consultant_clients cc
       JOIN organizations o ON o.id = cc.org_id
       WHERE cc.consultant_id = $1
       ORDER BY cc.created_at DESC`,
      [req.user.id]
    );

    res.json({ clients: result.rows });
  } catch (err) {
    console.error('Get consultant clients error:', err);
    res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

app.post('/api/consultants/clients', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'consultant') {
      return res.status(403).json({ error: 'Consultant access required' });
    }

    const { org_id } = req.body;
    if (!org_id) return res.status(400).json({ error: 'Organization ID is required' });

    // Check org exists
    const orgCheck = await pool.query('SELECT id FROM organizations WHERE id = $1', [org_id]);
    if (orgCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const result = await pool.query(
      `INSERT INTO consultant_clients (consultant_id, org_id) VALUES ($1, $2)
       ON CONFLICT (consultant_id, org_id) DO NOTHING
       RETURNING id`,
      [req.user.id, org_id]
    );

    // Update client count
    await pool.query(
      `UPDATE consultants SET client_count = (SELECT COUNT(*) FROM consultant_clients WHERE consultant_id = $1), updated_at = NOW() WHERE id = $1`,
      [req.user.id]
    );

    res.status(201).json({ message: 'Client linked successfully', id: result.rows[0]?.id || null });
  } catch (err) {
    console.error('Add consultant client error:', err);
    res.status(500).json({ error: 'Failed to add client' });
  }
});

// =====================================================
// ADMIN AUTH
// =====================================================

app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, role FROM admin_users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const admin = result.rows[0];
    const validPassword = await bcrypt.compare(password, admin.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: admin.id, email: admin.email, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });

    res.json({ token, admin: { id: admin.id, email: admin.email, role: admin.role } });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// =====================================================
// GRANT ROUTES
// =====================================================

app.get('/api/grants', async (req, res) => {
  try {
    const {
      country, funder_type, sector, eligibility_type,
      min_amount, max_amount, deadline_within, is_rolling,
      keyword, status, page = 1, limit = 20
    } = req.query;

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (country) {
      conditions.push(`country = $${paramIdx++}`);
      params.push(country);
    }
    if (funder_type) {
      conditions.push(`funder_type = $${paramIdx++}`);
      params.push(funder_type);
    }
    if (sector) {
      conditions.push(`$${paramIdx++} = ANY(sectors)`);
      params.push(sector);
    }
    if (eligibility_type) {
      conditions.push(`$${paramIdx++} = ANY(eligibility_types::text[])`);
      params.push(eligibility_type);
    }
    if (min_amount) {
      conditions.push(`funding_amount_max >= $${paramIdx++}`);
      params.push(parseFloat(min_amount));
    }
    if (max_amount) {
      conditions.push(`funding_amount_min <= $${paramIdx++}`);
      params.push(parseFloat(max_amount));
    }
    if (deadline_within) {
      const days = parseInt(deadline_within);
      if ([30, 60, 90, 180].includes(days)) {
        conditions.push(`deadline <= NOW() + INTERVAL '${days} days' AND deadline >= NOW()`);
      }
    }
    if (is_rolling === 'true') {
      conditions.push('is_rolling = true');
    }
    if (keyword) {
      conditions.push(`(title ILIKE $${paramIdx} OR description ILIKE $${paramIdx} OR $${paramIdx + 1} = ANY(keywords))`);
      params.push(`%${keyword}%`);
      paramIdx++;
      params.push(keyword);
      paramIdx++;
    }
    if (status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(status);
    } else {
      conditions.push(`status = 'active'`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Get total count
    const countResult = await pool.query(`SELECT COUNT(*) FROM grants ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);

    // Get paginated results
    const grantsResult = await pool.query(
      `SELECT * FROM grants ${whereClause} ORDER BY deadline ASC NULLS LAST, created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, parseInt(limit), offset]
    );

    const totalPages = Math.ceil(total / parseInt(limit));

    res.json({
      grants: grantsResult.rows,
      total,
      page: parseInt(page),
      totalPages
    });
  } catch (err) {
    console.error('Get grants error:', err);
    res.status(500).json({ error: 'Failed to fetch grants' });
  }
});

app.get('/api/grants/stats', async (req, res) => {
  try {
    const totalResult = await pool.query('SELECT COUNT(*) FROM grants');
    const activeResult = await pool.query("SELECT COUNT(*) FROM grants WHERE status = 'active'");
    const expiredResult = await pool.query("SELECT COUNT(*) FROM grants WHERE status = 'expired'");
    const upcomingResult = await pool.query("SELECT COUNT(*) FROM grants WHERE status = 'upcoming'");

    const byCountryResult = await pool.query(
      `SELECT country, COUNT(*) as count FROM grants WHERE status = 'active' GROUP BY country ORDER BY count DESC LIMIT 10`
    );

    const byFunderResult = await pool.query(
      `SELECT funder_type, COUNT(*) as count FROM grants WHERE status = 'active' AND funder_type IS NOT NULL GROUP BY funder_type ORDER BY count DESC`
    );

    const bySectorResult = await pool.query(
      `SELECT unnest(sectors) as sector, COUNT(*) as count FROM grants WHERE status = 'active' GROUP BY sector ORDER BY count DESC LIMIT 10`
    );

    const recentResult = await pool.query(
      `SELECT COUNT(*) FROM grants WHERE created_at >= NOW() - INTERVAL '7 days'`
    );

    res.json({
      total: parseInt(totalResult.rows[0].count),
      active: parseInt(activeResult.rows[0].count),
      expired: parseInt(expiredResult.rows[0].count),
      upcoming: parseInt(upcomingResult.rows[0].count),
      by_country: byCountryResult.rows,
      by_funder_type: byFunderResult.rows,
      by_sector: bySectorResult.rows,
      recently_added: parseInt(recentResult.rows[0].count)
    });
  } catch (err) {
    console.error('Get grant stats error:', err);
    res.status(500).json({ error: 'Failed to fetch grant stats' });
  }
});

app.get('/api/grants/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM grants WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Grant not found' });
    }

    res.json({ grant: result.rows[0] });
  } catch (err) {
    console.error('Get grant detail error:', err);
    res.status(500).json({ error: 'Failed to fetch grant' });
  }
});

// =====================================================
// MATCH ROUTES (authenticateToken)
// =====================================================

app.get('/api/matches', authenticateToken, async (req, res) => {
  try {
    const orgId = req.user.id;

    const result = await pool.query(
      `SELECT m.*, g.title, g.description, g.funder_name, g.funder_type, g.country, g.region,
              g.funding_amount_min, g.funding_amount_max, g.currency, g.deadline, g.is_rolling,
              g.eligibility_types, g.sectors, g.application_url, g.status as grant_status
       FROM matches m
       JOIN grants g ON g.id = m.grant_id
       WHERE m.org_id = $1
       ORDER BY m.score DESC`,
      [orgId]
    );

    res.json({ matches: result.rows });
  } catch (err) {
    console.error('Get matches error:', err);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

app.post('/api/matches/:id/viewed', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE matches SET viewed = true, updated_at = NOW() WHERE id = $1 AND org_id = $2 RETURNING id',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }

    res.json({ message: 'Match marked as viewed' });
  } catch (err) {
    console.error('Mark viewed error:', err);
    res.status(500).json({ error: 'Failed to update match' });
  }
});

app.post('/api/matches/:id/applied', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE matches SET applied = true, updated_at = NOW() WHERE id = $1 AND org_id = $2 RETURNING id, grant_id',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }

    // Create grant application record
    await pool.query(
      `INSERT INTO grant_applications (org_id, grant_id, status) VALUES ($1, $2, 'applied')
       ON CONFLICT DO NOTHING`,
      [req.user.id, result.rows[0].grant_id]
    );

    res.json({ message: 'Match marked as applied' });
  } catch (err) {
    console.error('Mark applied error:', err);
    res.status(500).json({ error: 'Failed to update match' });
  }
});

app.post('/api/matches/:id/awarded', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { award_amount } = req.body;

    const result = await pool.query(
      'UPDATE matches SET awarded = true, award_amount = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3 RETURNING id, grant_id',
      [award_amount || null, id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }

    // Update grant application
    await pool.query(
      `UPDATE grant_applications SET status = 'awarded', award_amount = $1, updated_at = NOW() WHERE org_id = $2 AND grant_id = $3`,
      [award_amount || null, req.user.id, result.rows[0].grant_id]
    );

    res.json({ message: 'Match marked as awarded' });
  } catch (err) {
    console.error('Mark awarded error:', err);
    res.status(500).json({ error: 'Failed to update match' });
  }
});

// =====================================================
// ORGANIZATION PROFILE (authenticateToken)
// =====================================================

app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, country, org_type, sectors, employee_count, annual_revenue, founded_year,
              is_indigenous, is_women_owned, is_nonprofit, subscription_tier, profile_complete, email_verified, created_at, updated_at
       FROM organizations WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json({ profile: result.rows[0] });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.put('/api/profile', authenticateToken, async (req, res) => {
  try {
    const {
      name, country, org_type, sectors, employee_count,
      annual_revenue, founded_year, is_indigenous, is_women_owned, is_nonprofit
    } = req.body;

    const profileComplete = !!(country && org_type && sectors && sectors.length > 0);

    const result = await pool.query(
      `UPDATE organizations SET
        name = COALESCE($1, name),
        country = COALESCE($2, country),
        org_type = COALESCE($3, org_type),
        sectors = COALESCE($4, sectors),
        employee_count = COALESCE($5, employee_count),
        annual_revenue = COALESCE($6, annual_revenue),
        founded_year = COALESCE($7, founded_year),
        is_indigenous = COALESCE($8, is_indigenous),
        is_women_owned = COALESCE($9, is_women_owned),
        is_nonprofit = COALESCE($10, is_nonprofit),
        profile_complete = $11,
        updated_at = NOW()
       WHERE id = $12
       RETURNING id, name, email, country, org_type, sectors, employee_count, annual_revenue, founded_year,
                 is_indigenous, is_women_owned, is_nonprofit, subscription_tier, profile_complete`,
      [name || null, country || null, org_type || null, sectors || null, employee_count || null,
       annual_revenue || null, founded_year || null, is_indigenous, is_women_owned, is_nonprofit,
       profileComplete, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json({ profile: result.rows[0], message: 'Profile updated successfully' });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

app.get('/api/profile/dashboard', authenticateToken, async (req, res) => {
  try {
    const orgId = req.user.id;

    // Profile
    const profileResult = await pool.query(
      `SELECT id, name, email, country, org_type, sectors, employee_count, annual_revenue,
              subscription_tier, profile_complete, email_verified, created_at
       FROM organizations WHERE id = $1`,
      [orgId]
    );

    if (profileResult.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Match count
    const matchCountResult = await pool.query(
      'SELECT COUNT(*) FROM matches WHERE org_id = $1',
      [orgId]
    );

    // Top 5 matches
    const topMatchesResult = await pool.query(
      `SELECT m.id, m.score, m.reasons, m.viewed, m.applied, m.awarded,
              g.title, g.funder_name, g.country, g.funding_amount_max, g.deadline, g.is_rolling
       FROM matches m
       JOIN grants g ON g.id = m.grant_id
       WHERE m.org_id = $1
       ORDER BY m.score DESC
       LIMIT 5`,
      [orgId]
    );

    // Upcoming deadlines (next 30 days)
    const upcomingResult = await pool.query(
      `SELECT m.id, m.score, g.title, g.funder_name, g.deadline, g.application_url
       FROM matches m
       JOIN grants g ON g.id = m.grant_id
       WHERE m.org_id = $1 AND g.deadline BETWEEN NOW() AND NOW() + INTERVAL '30 days'
       ORDER BY g.deadline ASC`,
      [orgId]
    );

    // Applied count
    const appliedResult = await pool.query(
      'SELECT COUNT(*) FROM matches WHERE org_id = $1 AND applied = true',
      [orgId]
    );

    // Awarded count and total
    const awardedResult = await pool.query(
      'SELECT COUNT(*) as count, COALESCE(SUM(award_amount), 0) as total FROM matches WHERE org_id = $1 AND awarded = true',
      [orgId]
    );

    res.json({
      profile: profileResult.rows[0],
      matchCount: parseInt(matchCountResult.rows[0].count),
      topMatches: topMatchesResult.rows,
      upcomingDeadlines: upcomingResult.rows,
      appliedCount: parseInt(appliedResult.rows[0].count),
      awardedCount: parseInt(awardedResult.rows[0].count),
      totalAwarded: parseFloat(awardedResult.rows[0].total)
    });
  } catch (err) {
    console.error('Get dashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard' });
  }
});

// =====================================================
// STRIPE ROUTES
// =====================================================

app.post('/api/stripe/create-checkout', authenticateToken, async (req, res) => {
  try {
    const { plan_type } = req.body;
    if (!plan_type || !STRIPE_PRICES[plan_type]) {
      return res.status(400).json({ error: 'Invalid plan type. Choose from: sme, professional, consultant, enterprise' });
    }

    const priceId = STRIPE_PRICES[plan_type];
    if (!priceId) {
      return res.status(400).json({ error: 'Stripe price ID not configured for this plan' });
    }

    const metadata = {};
    if (req.user.role === 'consultant') {
      metadata.consultant_id = req.user.id;
    } else {
      metadata.org_id = req.user.id;
    }
    metadata.plan_type = plan_type;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${FRONTEND_URL}/dashboard?checkout=success`,
      cancel_url: `${FRONTEND_URL}/pricing?checkout=cancelled`,
      customer_email: req.user.email,
      metadata,
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error('Create checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

app.get('/api/stripe/portal', authenticateToken, async (req, res) => {
  try {
    // Find customer ID
    let customerId = null;
    if (req.user.role === 'consultant') {
      const result = await pool.query('SELECT stripe_customer_id FROM consultants WHERE id = $1', [req.user.id]);
      customerId = result.rows[0]?.stripe_customer_id;
    } else {
      const result = await pool.query('SELECT stripe_customer_id FROM organizations WHERE id = $1', [req.user.id]);
      customerId = result.rows[0]?.stripe_customer_id;
    }

    if (!customerId) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${FRONTEND_URL}/dashboard`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Create portal error:', err);
    res.status(500).json({ error: 'Failed to create billing portal session' });
  }
});

// =====================================================
// CONTACT
// =====================================================

app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, company, subject, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required' });
    }

    try {
      await sendContactFormEmail({ name, email, company, subject, message });
    } catch (emailErr) {
      console.error('Contact email error:', emailErr.message);
    }

    res.json({ message: 'Thank you for your message. We will get back to you soon.' });
  } catch (err) {
    console.error('Contact form error:', err);
    res.status(500).json({ error: 'Failed to submit contact form' });
  }
});

// =====================================================
// ADMIN ROUTES (adminAuth)
// =====================================================

app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
  try {
    // Grant stats
    const totalGrants = await pool.query('SELECT COUNT(*) FROM grants');
    const activeGrants = await pool.query("SELECT COUNT(*) FROM grants WHERE status = 'active'");
    const expiredGrants = await pool.query("SELECT COUNT(*) FROM grants WHERE status = 'expired'");

    // Org stats
    const totalOrgs = await pool.query('SELECT COUNT(*) FROM organizations');
    const verifiedOrgs = await pool.query('SELECT COUNT(*) FROM organizations WHERE email_verified = true');
    const paidOrgs = await pool.query("SELECT COUNT(*) FROM organizations WHERE subscription_tier != 'free'");

    // Scraper health
    const scraperHealth = await pool.query(
      `SELECT source, status, records_found, records_inserted, started_at, completed_at
       FROM scrape_jobs
       WHERE id IN (SELECT MAX(id) FROM scrape_jobs GROUP BY source)
       ORDER BY started_at DESC`
    );

    // Recent jobs
    const recentJobs = await pool.query(
      'SELECT * FROM scrape_jobs ORDER BY started_at DESC LIMIT 10'
    );

    res.json({
      grantStats: {
        total: parseInt(totalGrants.rows[0].count),
        active: parseInt(activeGrants.rows[0].count),
        expired: parseInt(expiredGrants.rows[0].count)
      },
      orgStats: {
        total: parseInt(totalOrgs.rows[0].count),
        verified: parseInt(verifiedOrgs.rows[0].count),
        paid: parseInt(paidOrgs.rows[0].count)
      },
      scraperHealth: scraperHealth.rows,
      recentJobs: recentJobs.rows
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

app.get('/api/admin/grants', adminAuth, async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query, countQuery, params;

    if (search) {
      query = `SELECT * FROM grants WHERE title ILIKE $1 OR funder_name ILIKE $1 OR country ILIKE $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
      countQuery = `SELECT COUNT(*) FROM grants WHERE title ILIKE $1 OR funder_name ILIKE $1 OR country ILIKE $1`;
      params = [`%${search}%`];
    } else {
      query = `SELECT * FROM grants ORDER BY created_at DESC LIMIT $1 OFFSET $2`;
      countQuery = `SELECT COUNT(*) FROM grants`;
      params = [];
    }

    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count);

    const grantsResult = await pool.query(
      query,
      search ? [...params, parseInt(limit), offset] : [parseInt(limit), offset]
    );

    res.json({
      grants: grantsResult.rows,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit))
    });
  } catch (err) {
    console.error('Admin grants error:', err);
    res.status(500).json({ error: 'Failed to fetch grants' });
  }
});

app.post('/api/admin/grants', adminAuth, async (req, res) => {
  try {
    const {
      title, description, funder_name, funder_type, country, region,
      funding_amount_min, funding_amount_max, currency, deadline, is_rolling,
      eligibility_types, sectors, keywords, application_url, source_url, source_system, status
    } = req.body;

    if (!title) return res.status(400).json({ error: 'Title is required' });

    const result = await pool.query(
      `INSERT INTO grants (title, description, funder_name, funder_type, country, region, funding_amount_min, funding_amount_max, currency, deadline, is_rolling, eligibility_types, sectors, keywords, application_url, source_url, source_system, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *`,
      [title, description || null, funder_name || null, funder_type || null, country || null, region || null,
       funding_amount_min || null, funding_amount_max || null, currency || 'CAD', deadline || null,
       is_rolling || false, eligibility_types || '{}', sectors || '{}', keywords || '{}',
       application_url || null, source_url || null, source_system || 'manual', status || 'active']
    );

    res.status(201).json({ grant: result.rows[0], message: 'Grant created successfully' });
  } catch (err) {
    console.error('Create grant error:', err);
    res.status(500).json({ error: 'Failed to create grant' });
  }
});

app.put('/api/admin/grants/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title, description, funder_name, funder_type, country, region,
      funding_amount_min, funding_amount_max, currency, deadline, is_rolling,
      eligibility_types, sectors, keywords, application_url, source_url, source_system, status
    } = req.body;

    const result = await pool.query(
      `UPDATE grants SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        funder_name = COALESCE($3, funder_name),
        funder_type = COALESCE($4, funder_type),
        country = COALESCE($5, country),
        region = COALESCE($6, region),
        funding_amount_min = COALESCE($7, funding_amount_min),
        funding_amount_max = COALESCE($8, funding_amount_max),
        currency = COALESCE($9, currency),
        deadline = COALESCE($10, deadline),
        is_rolling = COALESCE($11, is_rolling),
        eligibility_types = COALESCE($12, eligibility_types),
        sectors = COALESCE($13, sectors),
        keywords = COALESCE($14, keywords),
        application_url = COALESCE($15, application_url),
        source_url = COALESCE($16, source_url),
        source_system = COALESCE($17, source_system),
        status = COALESCE($18, status),
        updated_at = NOW()
       WHERE id = $19
       RETURNING *`,
      [title || null, description || null, funder_name || null, funder_type || null, country || null, region || null,
       funding_amount_min || null, funding_amount_max || null, currency || null, deadline || null,
       is_rolling, eligibility_types || null, sectors || null, keywords || null,
       application_url || null, source_url || null, source_system || null, status || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Grant not found' });
    }

    res.json({ grant: result.rows[0], message: 'Grant updated successfully' });
  } catch (err) {
    console.error('Update grant error:', err);
    res.status(500).json({ error: 'Failed to update grant' });
  }
});

app.delete('/api/admin/grants/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM grants WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Grant not found' });
    }

    res.json({ message: 'Grant deleted successfully' });
  } catch (err) {
    console.error('Delete grant error:', err);
    res.status(500).json({ error: 'Failed to delete grant' });
  }
});

app.get('/api/admin/organizations', adminAuth, async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query, countQuery, params;

    if (search) {
      query = `SELECT id, name, email, country, org_type, sectors, employee_count, subscription_tier, email_verified, created_at
               FROM organizations WHERE name ILIKE $1 OR email ILIKE $1 OR country ILIKE $1
               ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
      countQuery = `SELECT COUNT(*) FROM organizations WHERE name ILIKE $1 OR email ILIKE $1 OR country ILIKE $1`;
      params = [`%${search}%`];
    } else {
      query = `SELECT id, name, email, country, org_type, sectors, employee_count, subscription_tier, email_verified, created_at
               FROM organizations ORDER BY created_at DESC LIMIT $1 OFFSET $2`;
      countQuery = `SELECT COUNT(*) FROM organizations`;
      params = [];
    }

    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count);

    const orgsResult = await pool.query(
      query,
      search ? [...params, parseInt(limit), offset] : [parseInt(limit), offset]
    );

    res.json({
      organizations: orgsResult.rows,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit))
    });
  } catch (err) {
    console.error('Admin organizations error:', err);
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
});

app.get('/api/admin/scrape-jobs', adminAuth, async (req, res) => {
  try {
    const { source, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query, countQuery, params;

    if (source) {
      query = 'SELECT * FROM scrape_jobs WHERE source = $1 ORDER BY started_at DESC LIMIT $2 OFFSET $3';
      countQuery = 'SELECT COUNT(*) FROM scrape_jobs WHERE source = $1';
      params = [source];
    } else {
      query = 'SELECT * FROM scrape_jobs ORDER BY started_at DESC LIMIT $1 OFFSET $2';
      countQuery = 'SELECT COUNT(*) FROM scrape_jobs';
      params = [];
    }

    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count);

    const jobsResult = await pool.query(
      query,
      source ? [...params, parseInt(limit), offset] : [parseInt(limit), offset]
    );

    res.json({
      jobs: jobsResult.rows,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit))
    });
  } catch (err) {
    console.error('Admin scrape jobs error:', err);
    res.status(500).json({ error: 'Failed to fetch scrape jobs' });
  }
});

app.post('/api/admin/scrape/trigger/:source', adminAuth, async (req, res) => {
  try {
    const { source } = req.params;
    const validSources = ['grants_gov', 'canada', 'eu', 'uk', 'au', 'sg', 'uae', 'foundations'];

    if (!validSources.includes(source)) {
      return res.status(400).json({ error: `Invalid source. Valid sources: ${validSources.join(', ')}` });
    }

    // Create scrape job
    const result = await pool.query(
      `INSERT INTO scrape_jobs (source, country, status) VALUES ($1, $2, 'running') RETURNING id`,
      [source, source === 'grants_gov' ? 'US' : source.toUpperCase()]
    );

    // In production, this would trigger the actual scraper
    console.log(`[Admin] Scraper triggered: ${source} (job #${result.rows[0].id})`);

    res.json({ message: `Scraper ${source} triggered`, jobId: result.rows[0].id });
  } catch (err) {
    console.error('Trigger scraper error:', err);
    res.status(500).json({ error: 'Failed to trigger scraper' });
  }
});

app.get('/api/admin/email-queue', adminAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query, countQuery, params;

    if (status) {
      query = 'SELECT * FROM email_queue WHERE status = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3';
      countQuery = 'SELECT COUNT(*) FROM email_queue WHERE status = $1';
      params = [status];
    } else {
      query = 'SELECT * FROM email_queue ORDER BY created_at DESC LIMIT $1 OFFSET $2';
      countQuery = 'SELECT COUNT(*) FROM email_queue';
      params = [];
    }

    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count);

    const emailsResult = await pool.query(
      query,
      status ? [...params, parseInt(limit), offset] : [parseInt(limit), offset]
    );

    // Summary stats
    const statsResult = await pool.query(
      `SELECT status, COUNT(*) as count FROM email_queue GROUP BY status`
    );

    res.json({
      emails: emailsResult.rows,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      stats: statsResult.rows
    });
  } catch (err) {
    console.error('Admin email queue error:', err);
    res.status(500).json({ error: 'Failed to fetch email queue' });
  }
});

// =====================================================
// SCRAPER ROUTES
// =====================================================

app.post('/api/scrape/trigger/:source', adminAuth, async (req, res) => {
  try {
    const { source } = req.params;
    const validSources = ['grants_gov', 'canada', 'eu', 'uk', 'au', 'sg', 'uae', 'foundations'];

    if (!validSources.includes(source)) {
      return res.status(400).json({ error: `Invalid source. Valid sources: ${validSources.join(', ')}` });
    }

    // Check if scraper is already running
    const running = await pool.query(
      "SELECT id FROM scrape_jobs WHERE source = $1 AND status = 'running'",
      [source]
    );

    if (running.rows.length > 0) {
      return res.status(409).json({ error: `Scraper ${source} is already running (job #${running.rows[0].id})` });
    }

    const countryMap = {
      grants_gov: 'US',
      canada: 'CA',
      eu: 'EU',
      uk: 'GB',
      au: 'AU',
      sg: 'SG',
      uae: 'AE',
      foundations: 'GLOBAL'
    };

    const result = await pool.query(
      `INSERT INTO scrape_jobs (source, country, status) VALUES ($1, $2, 'running') RETURNING id`,
      [source, countryMap[source] || source.toUpperCase()]
    );

    console.log(`[Scraper] Triggered: ${source} (job #${result.rows[0].id})`);

    // Trigger actual scraper in background (don't await)
    scraperOrchestrator.trigger(source).then(scraperResult => {
      console.log(`[Scraper] ${source} finished:`, JSON.stringify(scraperResult));
    }).catch(err => {
      console.error(`[Scraper] ${source} error:`, err.message);
    });

    res.json({ message: `Scraper ${source} triggered`, jobId: result.rows[0].id });
  } catch (err) {
    console.error('Trigger scraper error:', err);
    res.status(500).json({ error: 'Failed to trigger scraper' });
  }
});

app.get('/api/scrape/status', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM scrape_jobs WHERE status = 'running' OR status = 'pending' ORDER BY started_at DESC"
    );

    res.json({ running_jobs: result.rows });
  } catch (err) {
    console.error('Scrape status error:', err);
    res.status(500).json({ error: 'Failed to fetch scrape status' });
  }
});

app.get('/api/scrape/stats', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT source, COUNT(*) as job_count,
              SUM(records_found) as total_found,
              SUM(records_inserted) as total_inserted,
              SUM(records_updated) as total_updated,
              MAX(completed_at) as last_completed
       FROM scrape_jobs
       WHERE status = 'completed'
       GROUP BY source
       ORDER BY total_found DESC`
    );

    // Also get grant counts per source_system
    const grantCounts = await pool.query(
      `SELECT source_system, COUNT(*) as count FROM grants WHERE source_system IS NOT NULL GROUP BY source_system ORDER BY count DESC`
    );

    res.json({ scraper_stats: result.rows, grants_per_source: grantCounts.rows });
  } catch (err) {
    console.error('Scrape stats error:', err);
    res.status(500).json({ error: 'Failed to fetch scrape stats' });
  }
});

// =====================================================
// ELIGIBILITY QUIZ
// =====================================================

app.post('/api/eligibility-quiz', async (req, res) => {
  try {
    const {
      country, org_type, sectors, employee_count,
      annual_revenue, is_indigenous, is_women_owned, is_nonprofit,
      email, name, password
    } = req.body;

    if (!country || !org_type) {
      return res.status(400).json({ error: 'Country and organization type are required' });
    }

    let orgId = null;
    let token = null;

    // If email provided, create or update org
    if (email) {
      const existing = await pool.query('SELECT id FROM organizations WHERE email = $1', [email]);

      if (existing.rows.length > 0) {
        orgId = existing.rows[0].id;
        await pool.query(
          `UPDATE organizations SET
            country = COALESCE($1, country),
            org_type = COALESCE($2, org_type),
            sectors = COALESCE($3, sectors),
            employee_count = COALESCE($4, employee_count),
            annual_revenue = COALESCE($5, annual_revenue),
            is_indigenous = COALESCE($6, is_indigenous),
            is_women_owned = COALESCE($7, is_women_owned),
            is_nonprofit = COALESCE($8, is_nonprofit),
            profile_complete = true,
            updated_at = NOW()
           WHERE id = $9`,
          [country, org_type, sectors || '{}', employee_count || null, annual_revenue || null,
           is_indigenous || false, is_women_owned || false, is_nonprofit || false, orgId]
        );
      } else if (password) {
        const passwordHash = await bcrypt.hash(password, 10);
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const result = await pool.query(
          `INSERT INTO organizations (name, email, password_hash, country, org_type, sectors, employee_count, annual_revenue, is_indigenous, is_women_owned, is_nonprofit, verification_token, profile_complete)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
           RETURNING id`,
          [name || email.split('@')[0], email, passwordHash, country, org_type, sectors || '{}',
           employee_count || null, annual_revenue || null, is_indigenous || false,
           is_women_owned || false, is_nonprofit || false, verificationToken]
        );
        orgId = result.rows[0].id;
        token = jwt.sign({ id: orgId, email, role: 'org' }, JWT_SECRET, { expiresIn: '7d' });
      }
    }

    // Build matching query
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    // Country match
    conditions.push(`(country = $${paramIdx} OR country IS NULL)`);
    params.push(country);
    paramIdx++;

    // Status must be active
    conditions.push(`status = 'active'`);

    // Deadline not passed (or rolling)
    conditions.push(`(deadline > NOW() OR is_rolling = true OR deadline IS NULL)`);

    const whereClause = conditions.join(' AND ');

    const grantsResult = await pool.query(
      `SELECT * FROM grants WHERE ${whereClause} ORDER BY deadline ASC NULLS LAST LIMIT 100`,
      params
    );

    // Score each grant
    const scoredGrants = grantsResult.rows.map(grant => {
      let score = 0;
      const reasons = [];

      // Country match
      if (grant.country === country) {
        score += 25;
        reasons.push('Country match');
      }

      // Eligibility type match
      const eligTypes = grant.eligibility_types || [];
      if (eligTypes.includes('any')) {
        score += 15;
        reasons.push('Open to all organization types');
      } else if (eligTypes.includes(org_type)) {
        score += 20;
        reasons.push(`Eligible for ${org_type} organizations`);
      }
      if (is_indigenous && eligTypes.includes('indigenous')) {
        score += 15;
        reasons.push('Indigenous organization priority');
      }
      if (is_women_owned && eligTypes.includes('women_owned')) {
        score += 15;
        reasons.push('Women-owned organization priority');
      }
      if (is_nonprofit && eligTypes.includes('nonprofit')) {
        score += 10;
        reasons.push('Nonprofit eligible');
      }

      // Sector overlap
      const grantSectors = grant.sectors || [];
      const orgSectors = sectors || [];
      const sectorOverlap = orgSectors.filter(s => grantSectors.includes(s));
      if (sectorOverlap.length > 0) {
        score += Math.min(sectorOverlap.length * 10, 20);
        reasons.push(`Sector match: ${sectorOverlap.join(', ')}`);
      }

      // Funding amount relevance
      if (grant.funding_amount_max && annual_revenue) {
        const ratio = grant.funding_amount_max / annual_revenue;
        if (ratio >= 0.01 && ratio <= 1) {
          score += 10;
          reasons.push('Funding amount appropriate for organization size');
        }
      }

      // Employee count relevance (smaller orgs often get more grants)
      if (employee_count && employee_count < 50) {
        score += 5;
        reasons.push('Small organization bonus');
      }

      // Normalize to 0-1 range
      const normalizedScore = Math.min(score / 100, 1);

      return {
        ...grant,
        score: normalizedScore,
        reasons
      };
    });

    // Sort by score and take top 10
    const topMatches = scoredGrants
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    // If org exists, save matches
    if (orgId) {
      for (const match of topMatches) {
        try {
          await pool.query(
            `INSERT INTO matches (org_id, grant_id, score, reasons)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (org_id, grant_id) DO UPDATE SET score = $3, reasons = $4, updated_at = NOW()`,
            [orgId, match.id, match.score, match.reasons]
          );
        } catch (matchErr) {
          console.error('Failed to save match:', matchErr.message);
        }
      }
    }

    const response = {
      matches: topMatches,
      total_grants_analyzed: grantsResult.rows.length,
      message: `Found ${topMatches.length} matching grants based on your profile`
    };

    if (token) {
      response.token = token;
    }

    res.json(response);
  } catch (err) {
    console.error('Eligibility quiz error:', err);
    res.status(500).json({ error: 'Failed to process eligibility quiz' });
  }
});

// =====================================================
// CRON JOBS
// =====================================================

// Daily at 2am UTC: refresh Grants.gov
cron.schedule('0 2 * * *', async () => {
  console.log('[Cron] Daily Grants.gov refresh triggered');
  try {
    await pool.query(
      `INSERT INTO scrape_jobs (source, country, status) VALUES ('grants_gov', 'US', 'pending')`
    );
    // In production, trigger actual scraper
    console.log('[Cron] Grants.gov scrape job created');
  } catch (err) {
    console.error('[Cron] Failed to schedule Grants.gov scrape:', err.message);
  }
});

// Weekly Sunday 3am UTC: refresh Canada, EU, UK, AU, SG, UAE
cron.schedule('0 3 * * 0', async () => {
  console.log('[Cron] Weekly country scrapers triggered');
  const sources = ['canada', 'eu', 'uk', 'au', 'sg', 'uae'];
  const countryMap = { canada: 'CA', eu: 'EU', uk: 'GB', au: 'AU', sg: 'SG', uae: 'AE' };
  for (const source of sources) {
    try {
      await pool.query(
        `INSERT INTO scrape_jobs (source, country, status) VALUES ($1, $2, 'pending')`,
        [source, countryMap[source]]
      );
      console.log(`[Cron] ${source} scrape job created`);
    } catch (err) {
      console.error(`[Cron] Failed to schedule ${source} scrape:`, err.message);
    }
  }
});

// Monthly 1st at 4am UTC: refresh foundation grants
cron.schedule('0 4 1 * *', async () => {
  console.log('[Cron] Monthly foundation scraper triggered');
  try {
    await pool.query(
      `INSERT INTO scrape_jobs (source, country, status) VALUES ('foundations', 'GLOBAL', 'pending')`
    );
    console.log('[Cron] Foundation scrape job created');
  } catch (err) {
    console.error('[Cron] Failed to schedule foundation scrape:', err.message);
  }
});

// Daily 6am UTC: deadline monitoring
cron.schedule('0 6 * * *', async () => {
  console.log('[Cron] Deadline monitoring triggered');
  try {
    // Find orgs with grants expiring in 7 days
    const expiringMatches = await pool.query(
      `SELECT o.email, o.name,
              json_agg(json_build_object(
                'title', g.title,
                'funder_name', g.funder_name,
                'country', g.country,
                'deadline', g.deadline,
                'application_url', g.application_url
              )) as grants
       FROM matches m
       JOIN organizations o ON o.id = m.org_id
       JOIN grants g ON g.id = m.grant_id
       WHERE g.deadline BETWEEN NOW() AND NOW() + INTERVAL '7 days'
         AND m.applied = false
         AND o.email_verified = true
       GROUP BY o.id, o.email, o.name`
    );

    for (const row of expiringMatches.rows) {
      try {
        await sendDeadlineAlert(row.email, row.grants);
        console.log(`[Cron] Deadline alert sent to ${row.email} for ${row.grants.length} grants`);
      } catch (emailErr) {
        console.error(`[Cron] Failed to send deadline alert to ${row.email}:`, emailErr.message);
      }
    }

    // Update expired grants
    const expiredResult = await pool.query(
      `UPDATE grants SET status = 'expired', updated_at = NOW()
       WHERE deadline < NOW() AND status = 'active' AND is_rolling = false`
    );
    if (expiredResult.rowCount > 0) {
      console.log(`[Cron] Marked ${expiredResult.rowCount} grants as expired`);
    }

    console.log(`[Cron] Deadline monitoring complete: ${expiringMatches.rows.length} orgs notified`);
  } catch (err) {
    console.error('[Cron] Deadline monitoring error:', err.message);
  }
});

// Nightly 1am UTC: run AI matching for all active orgs
cron.schedule('0 1 * * *', async () => {
  console.log('[Cron] Nightly AI matching triggered');
  try {
    // Get all orgs with complete profiles
    const orgs = await pool.query(
      `SELECT id, country, org_type, sectors, employee_count, annual_revenue, email,
              is_indigenous, is_women_owned, is_nonprofit
       FROM organizations
       WHERE profile_complete = true AND email_verified = true`
    );

    // Get all active grants
    const grants = await pool.query(
      `SELECT * FROM grants WHERE status = 'active' AND (deadline > NOW() OR is_rolling = true OR deadline IS NULL)`
    );

    let matchesCreated = 0;

    for (const org of orgs.rows) {
      const newMatches = [];

      for (const grant of grants.rows) {
        let score = 0;
        const reasons = [];

        // Country
        if (grant.country === org.country) {
          score += 25;
          reasons.push('Country match');
        }

        // Eligibility
        const eligTypes = grant.eligibility_types || [];
        if (eligTypes.includes('any') || eligTypes.includes(org.org_type)) {
          score += 20;
          reasons.push('Eligibility match');
        }
        if (org.is_indigenous && eligTypes.includes('indigenous')) {
          score += 15;
          reasons.push('Indigenous priority');
        }
        if (org.is_women_owned && eligTypes.includes('women_owned')) {
          score += 15;
          reasons.push('Women-owned priority');
        }
        if (org.is_nonprofit && eligTypes.includes('nonprofit')) {
          score += 10;
          reasons.push('Nonprofit eligible');
        }

        // Sector overlap
        const sectorOverlap = (org.sectors || []).filter(s => (grant.sectors || []).includes(s));
        if (sectorOverlap.length > 0) {
          score += Math.min(sectorOverlap.length * 10, 20);
          reasons.push(`Sectors: ${sectorOverlap.join(', ')}`);
        }

        const normalizedScore = Math.min(score / 100, 1);

        if (normalizedScore >= 0.3) {
          newMatches.push({ grant_id: grant.id, score: normalizedScore, reasons });
        }
      }

      // Insert top matches
      const topN = newMatches.sort((a, b) => b.score - a.score).slice(0, 20);
      for (const match of topN) {
        try {
          const result = await pool.query(
            `INSERT INTO matches (org_id, grant_id, score, reasons)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (org_id, grant_id) DO UPDATE SET score = $3, reasons = $4, updated_at = NOW()
             RETURNING id`,
            [org.id, match.grant_id, match.score, match.reasons]
          );
          if (result.rowCount > 0) matchesCreated++;
        } catch (e) {
          // skip duplicate errors silently
        }
      }

      // Send digest if new matches found
      if (topN.length > 0) {
        try {
          const matchDetails = [];
          for (const m of topN.slice(0, 5)) {
            const grantDetail = grants.rows.find(g => g.id === m.grant_id);
            if (grantDetail) {
              matchDetails.push({ ...grantDetail, score: m.score });
            }
          }
          if (matchDetails.length > 0) {
            await sendMatchDigest(org.email, matchDetails);
          }
        } catch (emailErr) {
          console.error(`[Cron] Failed to send match digest to ${org.email}:`, emailErr.message);
        }
      }
    }

    console.log(`[Cron] Nightly matching complete: ${matchesCreated} matches created/updated for ${orgs.rows.length} organizations`);
  } catch (err) {
    console.error('[Cron] Nightly matching error:', err.message);
  }
});

// =====================================================
// SERVER START
// =====================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`GrantRadar backend running on port ${PORT}`);
});
