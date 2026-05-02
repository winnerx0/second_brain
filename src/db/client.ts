import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '../config.ts';

export const db = drizzle(config.DATABASE_URL);
