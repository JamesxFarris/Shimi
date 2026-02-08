// Database module for PostgreSQL connection and initialization
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false
});

// Initialize tables on startup
export async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_data (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64) UNIQUE NOT NULL,
        config JSONB NOT NULL DEFAULT '{}',
        portfolio JSONB NOT NULL DEFAULT '{}',
        bet_history JSONB NOT NULL DEFAULT '[]',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Database tables initialized');
  } finally {
    client.release();
  }
}

export { pool };
