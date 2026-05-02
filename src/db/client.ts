import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { config } from '../config.js';

const hasSslMode = /[?&]sslmode=/.test(config.DATABASE_URL);
const connectionString = hasSslMode
  ? config.DATABASE_URL.replace(/([?&])sslmode=[^&]*&?/g, '$1').replace(/[?&]$/, '')
  : config.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: hasSslMode ? { rejectUnauthorized: true } : undefined,
});

export const db = drizzle(pool);
