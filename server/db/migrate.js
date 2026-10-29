import { closeDatabase, connectDatabase } from './index.js';

try {
  await connectDatabase();
  console.log('MongoDB indexes and initial data are up to date.');
} catch (error) {
  console.error('MongoDB migration failed:', error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
