import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './index.js';
import { parseTimetable, importTimetable } from '../services/importTimetable.js';

try {
  if(process.env.ADMIN_EMAIL&&process.env.ADMIN_PASSWORD){
    const passwordHash=await bcrypt.hash(process.env.ADMIN_PASSWORD,12);
    await pool.query(`INSERT INTO students(name,email,password_hash,role) VALUES('Timetable administrator',$1,$2,'admin')
      ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,role='admin'`,[process.env.ADMIN_EMAIL.toLowerCase(),passwordHash]);
  }
  const sample=fileURLToPath(new URL('../../sample-timetable.csv',import.meta.url));
  const bytes=await readFile(sample);
  const rows=await parseTimetable(bytes,'sample-timetable.csv');
  const {rows:admins}=await pool.query("SELECT id FROM students WHERE role='admin' ORDER BY id LIMIT 1");
  await importTimetable(rows,'sample-timetable.csv',admins[0]?.id||null);
  console.log(`Imported ${rows.length} sample timetable rows.`);
}catch(error){console.error('Seeding failed:',error.message);process.exitCode=1}
finally{await pool.end()}
