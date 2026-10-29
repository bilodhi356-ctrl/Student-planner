import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { closeDatabase, collections, connectDatabase } from './index.js';
import { parseTimetable, importTimetable } from '../services/importTimetable.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

try {
  await connectDatabase();
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await collections.students.updateOne(
      { email: process.env.ADMIN_EMAIL.toLowerCase() },
      { $set: { password_hash: passwordHash, role: 'admin' }, $setOnInsert: {
        name: 'Timetable administrator',
        created_at: new Date(),
        program_id: null,
        year_of_study: null,
        semester: null
      } },
      { upsert: true }
    );
  }
  const sample = fileURLToPath(new URL('../../sample-timetable.csv', import.meta.url));
  const bytes = await readFile(sample);
  const rows = await parseTimetable(bytes, 'sample-timetable.csv');
  const admin = await collections.students.findOne({ role: 'admin' }, { sort: { _id: 1 }, projection: { _id: 1 } });
  await importTimetable(rows, 'sample-timetable.csv', admin?._id || null);
  console.log(`Imported ${rows.length} sample timetable rows.`);
} catch (error) {
  console.error('Seeding failed:', error.message);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
