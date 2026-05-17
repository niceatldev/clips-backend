import dotenv from 'dotenv';
import pg from 'pg';
import type { QueryResultRow } from 'pg';

dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

export const query = <T extends QueryResultRow>(text: string, values?: unknown[]) => pool.query<T>(text, values);
