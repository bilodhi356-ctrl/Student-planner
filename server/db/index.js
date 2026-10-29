import { MongoClient } from 'mongodb';
import 'dotenv/config';

export const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017');
export const database = client.db(process.env.MONGODB_DB || 'student_planner');

export const collections = {
  programs: database.collection('programs'),
  students: database.collection('students'),
  venues: database.collection('venues'),
  units: database.collection('units'),
  unitPrograms: database.collection('unit_programs'),
  sessions: database.collection('sessions'),
  selections: database.collection('selections'),
  timetableImports: database.collection('timetable_imports'),
  timetableChanges: database.collection('timetable_changes'),
  reminderPreferences: database.collection('reminder_preferences'),
  reminderDeliveries: database.collection('reminder_deliveries')
};

export async function connectDatabase() {
  await client.connect();
  await Promise.all([
    collections.programs.createIndex({ code: 1 }, { unique: true }),
    collections.students.createIndex({ email: 1 }, { unique: true }),
    collections.students.createIndex({ registration_number: 1 }, {
      unique: true,
      partialFilterExpression: { registration_number: { $type: 'string' } }
    }),
    collections.venues.createIndex({ name: 1 }, { unique: true }),
    collections.units.createIndex({ code: 1 }, { unique: true }),
    collections.unitPrograms.createIndex({ unit_id: 1, program_id: 1 }, { unique: true }),
    collections.sessions.createIndex({ unit_id: 1 }),
    collections.sessions.createIndex({ session_date: 1 }),
    collections.selections.createIndex({ student_id: 1, unit_id: 1 }, { unique: true }),
    collections.reminderPreferences.createIndex({ student_id: 1 }, { unique: true }),
    collections.reminderDeliveries.createIndex(
      { student_id: 1, session_id: 1, occurrence_start: 1, reminder_kind: 1 },
      { unique: true }
    )
  ]);
  await collections.programs.bulkWrite([
    { updateOne: { filter: { code: 'BSC-CT' }, update: { $setOnInsert: { name: 'BSc Computer Technology' } }, upsert: true } },
    { updateOne: { filter: { code: 'BSC-CS' }, update: { $setOnInsert: { name: 'BSc Computer Science' } }, upsert: true } }
  ]);
}

export async function closeDatabase() {
  await client.close();
}
