import { Pool } from 'pg';
import { env } from '../config/env.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.NODE_ENV === 'test' ? 5 : 10,
});
