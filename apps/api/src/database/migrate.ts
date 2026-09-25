import { getMigrations } from 'better-auth/db/migration';
import { auth } from '../auth/auth.config.js';
import { pool } from './pool.js';

async function migrate(): Promise<void> {
  const migration = await getMigrations(auth.options);
  await migration.runMigrations();
  console.log('Database migrations completed.');
  await pool.end();
}

migrate().catch(async (error) => {
  console.error('Database migration failed.', error);
  await pool.end();
  process.exitCode = 1;
});
