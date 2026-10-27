import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './index.js';

try {
  const path = fileURLToPath(new URL('./schema.sql', import.meta.url));
  await pool.query(await readFile(path, 'utf8'));
  console.log('Database schema is up to date.');
} catch (error) {
  console.error('Database migration failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
