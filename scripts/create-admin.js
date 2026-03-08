require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function createAdmin() {
  const email = process.env.ADMIN_EMAIL || 'arthur@negotiateandwin.com';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO admin_users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET password_hash = $2',
    [email, hash]
  );
  console.log(`Admin created: ${email}`);
  await pool.end();
}

createAdmin();
