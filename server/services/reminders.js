import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
import nodemailer from 'nodemailer';
import { addDays, addMinutes, format, isAfter, isBefore } from 'date-fns';
import { collections } from '../db/index.js';
import { expandSessions } from '../domain/clashes.js';

const configured = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD;
const mailer = configured ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
}) : null;

export function startReminderJob() {
  if (!mailer) { console.log('Email reminders are disabled until SMTP settings are configured.'); return; }
  cron.schedule('*/5 * * * *', async () => {
    try {
      const [students, selections, units, sessions, venues] = await Promise.all([
        collections.students.find({}, { projection: { name: 1, email: 1 } }).toArray(),
        collections.selections.find().toArray(),
        collections.units.find().toArray(),
        collections.sessions.find().toArray(),
        collections.venues.find().toArray()
      ]);
      const preferences = await collections.reminderPreferences.find({ enabled: true }).toArray();
      const studentsById = new Map(students.map((student) => [student._id, student]));
      const unitsById = new Map(units.map((unit) => [unit._id, unit]));
      const venuesById = new Map(venues.map((venue) => [venue._id, venue]));
      const selectionsByStudent = new Map();
      for (const selection of selections) {
        const selected = selectionsByStudent.get(selection.student_id) || [];
        selected.push(selection);
        selectionsByStudent.set(selection.student_id, selected);
      }
      const now = new Date();
      for (const preference of preferences) {
        const student = studentsById.get(preference.student_id);
        if (!student) continue;
        const selectedUnits = selectionsByStudent.get(student._id) || [];
        const selectionByUnit = new Map(selectedUnits.map((selection) => [selection.unit_id, selection]));
        const studentSessions = sessions.flatMap((session) => {
          const selection = selectionByUnit.get(session.unit_id);
          const unit = unitsById.get(session.unit_id);
          if (!selection || !unit || (selection.selected_group && selection.selected_group !== session.group_name)) return [];
          const venue = venuesById.get(session.venue_id);
          return [{
            id: session._id,
            unit_id: unit._id,
            code: unit.code,
            name: unit.name,
            kind: session.kind,
            group_name: session.group_name,
            day_of_week: session.day_of_week,
            session_date: session.session_date,
            start_time: session.start_time,
            end_time: session.end_time,
            venue: venue?.name || null
          }];
        });
        const instances = expandSessions(studentSessions, format(now, 'yyyy-MM-dd'), format(addDays(now, 15), 'yyyy-MM-dd'));
        const firstClasses = new Map();
        for (const item of instances.filter((session) => session.kind === 'lecture')) {
          if (!firstClasses.has(item.unit_id)) firstClasses.set(item.unit_id, item);
        }
        const candidates = [
          ...instances.filter((session) => session.kind === 'exam').map((item) => ({
            ...item,
            reminder_kind: 'exam',
            threshold: preference.exam_hours_before * 60
          })),
          ...firstClasses.values()
        ].map((item) => item.reminder_kind ? item : {
          ...item,
          reminder_kind: 'first-class',
          threshold: preference.class_minutes_before
        });
        for (const item of candidates) {
          const start = item.start;
          const reminderAt = addMinutes(start, -item.threshold);
          if (isBefore(reminderAt, addMinutes(now, -5)) || isAfter(reminderAt, addMinutes(now, 5))) continue;
          const delivery = {
            student_id: student._id,
            session_id: item.id,
            occurrence_start: start,
            reminder_kind: item.reminder_kind
          };
          if (await collections.reminderDeliveries.findOne(delivery, { projection: { _id: 1 } })) continue;
          const label = item.reminder_kind === 'exam' ? 'Exam' : 'First class';
          await mailer.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: student.email,
            subject: `${label} reminder: ${item.code}`,
            text: `Hi ${student.name},\n\nYour ${label.toLowerCase()} for ${item.code} — ${item.name} starts at ${format(start, 'PPpp')}${item.venue ? ` in ${item.venue}` : ''}.\n\nStudent Planner`
          });
          await collections.reminderDeliveries.insertOne({ _id: randomUUID(), ...delivery, sent_at: new Date() });
        }
      }
    } catch (error) { console.error('Reminder job failed:', error.message); }
  }, { timezone: process.env.APP_TIME_ZONE || 'UTC' });
}
