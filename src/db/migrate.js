require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('Migration completed successfully');
  } catch (err) {
    console.error('Migration failed:', err.message);
    // If types already exist, try running without CREATE TYPE
    if (err.message.includes('already exists')) {
      console.log('Types already exist, running table creation only...');
      const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      const statements = sql.split(';').filter(s =>
        !s.includes('CREATE TYPE') && !s.includes('CREATE EXTENSION') && s.trim()
      );
      for (const stmt of statements) {
        try {
          await pool.query(stmt);
        } catch (e) {
          console.log(`Skipping: ${e.message.substring(0, 60)}`);
        }
      }
      console.log('Table creation completed');
    }
  } finally {
    await pool.end();
  }
}

migrate();
