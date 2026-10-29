import { Router } from 'express';
import express from 'express';
import { createEvents } from 'ics';
import { parseTimetable, importTimetable } from '../services/importTimetable.js';
import { importUnitOfferings, parseUnitOfferings } from '../services/unitOfferings.js';
import { detectScheduleClashes } from '../domain/clashes.js';
import { collections } from '../db/index.js';
import { requireAdmin, requireAdministrator, requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/programs', async (_req, res, next) => {
  try {
    const programs = await collections.programs.find({}, { projection: { code: 1, name: 1 } }).sort({ name: 1 }).toArray();
    res.json(programs.map(({ _id, ...program }) => ({ id: _id, ...program })));
  } catch (error) { next(error); }
});

router.get('/academic-profile', async (req, res, next) => {
  try {
    const student = await collections.students.findOne(
      { _id: req.user.sub },
      { projection: { program_id: 1, year_of_study: 1, semester: 1 } }
    );
    res.json(student ? {
      program_id: student.program_id,
      year_of_study: student.year_of_study,
      semester: student.semester
    } : {});
  } catch (error) { next(error); }
});

router.get('/admin/stats', requireAdministrator, async (_req, res, next) => {
  try {
    res.json({ student_count: await collections.students.countDocuments({ role: 'student' }) });
  } catch (error) { next(error); }
});

router.get('/admin/students', requireAdministrator, async (_req, res, next) => {
  try {
    const [students, programs] = await Promise.all([
      collections.students.find({ role: 'student' }).toArray(),
      collections.programs.find().toArray()
    ]);
    const programNames = new Map(programs.map((program) => [program._id, program.name]));
    res.json(students
      .map((student) => ({
        id: student._id,
        name: student.name,
        email: student.email,
        registration_number: student.registration_number,
        program: programNames.get(student.program_id) || null,
        year_of_study: student.year_of_study,
        semester: student.semester,
        created_at: student.created_at
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email)));
  } catch (error) { next(error); }
});

router.get('/units', async (req, res, next) => {
  try {
    const { year, semester, program } = req.query;
    const query = { active: true };
    if (year) query.year = Number(year);
    if (semester) query.semester = Number(semester);
    let units = await collections.units.find(query).toArray();
    if (program) {
      const links = await collections.unitPrograms.find({ program_id: String(program) }).toArray();
      const linkedUnitIds = new Set(links.map((link) => link.unit_id));
      units = units.filter((unit) => linkedUnitIds.has(unit._id));
    }
    const unitIds = units.map((unit) => unit._id);
    const sessions = unitIds.length
      ? await collections.sessions.find({ unit_id: { $in: unitIds } }, { projection: { unit_id: 1, group_name: 1 } }).toArray()
      : [];
    const groupsByUnit = new Map();
    for (const session of sessions) {
      const groups = groupsByUnit.get(session.unit_id) || new Set();
      groups.add(session.group_name);
      groupsByUnit.set(session.unit_id, groups);
    }
    res.json(units
      .map((unit) => ({
        id: unit._id,
        code: unit.code,
        name: unit.name,
        year: unit.year,
        semester: unit.semester,
        groups: [...(groupsByUnit.get(unit._id) || [])].sort()
      }))
      .sort((a, b) => a.code.localeCompare(b.code)));
  } catch (error) { next(error); }
});

router.get('/selections', async (req, res, next) => {
  try {
    const selections = await collections.selections.find({ student_id: req.user.sub }).toArray();
    const unitIds = selections.map((selection) => selection.unit_id);
    const units = unitIds.length ? await collections.units.find({ _id: { $in: unitIds } }).toArray() : [];
    const unitsById = new Map(units.map((unit) => [unit._id, unit]));
    res.json(selections.flatMap((selection) => {
      const unit = unitsById.get(selection.unit_id);
      return unit ? [{
        unit_id: unit._id,
        code: unit.code,
        name: unit.name,
        year: unit.year,
        semester: unit.semester,
        selected_group: selection.selected_group
      }] : [];
    }).sort((a, b) => a.code.localeCompare(b.code)));
  } catch (error) { next(error); }
});

router.put('/selections', async (req, res, next) => {
  try {
    const choices = Array.isArray(req.body.units) ? req.body.units : [];
    const academic = req.body.academic || {};
    await collections.students.updateOne(
      { _id: req.user.sub },
      { $set: {
        program_id: academic.program_id || null,
        year_of_study: academic.year ? Number(academic.year) : null,
        semester: academic.semester ? Number(academic.semester) : null
      } }
    );
    await collections.selections.deleteMany({ student_id: req.user.sub });
    const uniqueChoices = [...new Map(choices.filter((choice) => choice?.id).map((choice) => [String(choice.id), choice])).values()];
    const validUnits = uniqueChoices.length
      ? await collections.units.find({ _id: { $in: uniqueChoices.map((choice) => String(choice.id)) } }, { projection: { _id: 1 } }).toArray()
      : [];
    const validUnitIds = new Set(validUnits.map((unit) => unit._id));
    const selectionDocuments = uniqueChoices
      .filter((choice) => validUnitIds.has(String(choice.id)))
      .map((choice) => ({
        _id: `${req.user.sub}:${choice.id}`,
        student_id: req.user.sub,
        unit_id: String(choice.id),
        selected_group: choice.group || null
      }));
    if (selectionDocuments.length) await collections.selections.insertMany(selectionDocuments);
    res.json({ saved: selectionDocuments.length });
  } catch (error) { next(error); }
});

async function getSelectedSessions(studentId, { from, to, kind } = {}) {
  const selections = await collections.selections.find({ student_id: studentId }).toArray();
  const unitIds = [...new Set(selections.map((selection) => selection.unit_id))];
  if (!unitIds.length) return [];
  const [sessions, units, venues] = await Promise.all([
    collections.sessions.find({ unit_id: { $in: unitIds } }).toArray(),
    collections.units.find({ _id: { $in: unitIds } }).toArray(),
    collections.venues.find().toArray()
  ]);
  const selectionsByUnit = new Map(selections.map((selection) => [selection.unit_id, selection]));
  const unitsById = new Map(units.map((unit) => [unit._id, unit]));
  const venuesById = new Map(venues.map((venue) => [venue._id, venue]));
  return sessions.flatMap((session) => {
    const selection = selectionsByUnit.get(session.unit_id);
    const unit = unitsById.get(session.unit_id);
    if (!selection || !unit || (selection.selected_group && selection.selected_group !== session.group_name)) return [];
    if (kind && session.kind !== kind) return [];
    if (session.kind !== 'lecture' && ((from && session.session_date < from) || (to && session.session_date > to))) return [];
    const venue = venuesById.get(session.venue_id);
    return [{
      id: session._id,
      unit_id: unit._id,
      code: unit.code,
      name: unit.name,
      year: unit.year,
      semester: unit.semester,
      kind: session.kind,
      group_name: session.group_name,
      day_of_week: session.day_of_week,
      session_date: session.session_date,
      start_time: session.start_time,
      end_time: session.end_time,
      venue: venue?.name || null,
      building: venue?.building || null,
      selected_group: selection.selected_group
    }];
  }).sort((a, b) => (a.day_of_week ?? 7) - (b.day_of_week ?? 7)
    || a.start_time.localeCompare(b.start_time)
    || String(a.session_date || '').localeCompare(String(b.session_date || '')));
}

router.get('/timetable', async (req, res, next) => {
  try {
    const from = req.query.from;
    const to = req.query.to;
    if (!from || !to) return res.status(400).json({ error: 'Provide from and to dates (YYYY-MM-DD).' });
    const sessions = await getSelectedSessions(req.user.sub, { from, to });
    const selections = await collections.selections.find({ student_id: req.user.sub }).toArray();
    const unitIds = [...new Set(selections.map((selection) => selection.unit_id))];
    const [allSessions, units] = await Promise.all([
      unitIds.length ? collections.sessions.find({ unit_id: { $in: unitIds } }).toArray() : [],
      unitIds.length ? collections.units.find({ _id: { $in: unitIds } }).toArray() : []
    ]);
    const unitsById = new Map(units.map((unit) => [unit._id, unit]));
    const groups = allSessions.flatMap((session) => {
      const unit = unitsById.get(session.unit_id);
      return unit ? [{ unit_id: unit._id, code: unit.code, group_name: session.group_name }] : [];
    });
    const uniqueGroups = [...new Map(groups.map((group) => [`${group.unit_id}:${group.group_name}`, group])).values()]
      .sort((a, b) => a.unit_id.localeCompare(b.unit_id) || a.group_name.localeCompare(b.group_name));
    const clashes = detectScheduleClashes(sessions, from, to);
    const selectedUnits = [...new Set(sessions.map((session) => String(session.unit_id)))];
    const suggestions = [];
    for (const unitId of selectedUnits) {
      const availableGroups = uniqueGroups.filter((row) => row.unit_id === unitId).map((row) => row.group_name);
      const currentGroups = new Set(sessions.filter((session) => String(session.unit_id) === unitId).map((session) => session.group_name));
      for (const groupName of availableGroups) {
        if (currentGroups.size === 1 && currentGroups.has(groupName)) continue;
        const candidates = await getSessionsForUnitGroup(unitId, groupName);
        const alternativeClashes = detectScheduleClashes([
          ...sessions.filter((session) => String(session.unit_id) !== unitId),
          ...candidates
        ], from, to);
        const blocked = alternativeClashes.some((clash) => String(clash.a.unit_id) === unitId || String(clash.b.unit_id) === unitId);
        if (!blocked) suggestions.push({ unit_id: unitId, group_name: groupName });
      }
    }
    res.json({ sessions, clashes, groups: uniqueGroups, suggestions });
  } catch (error) { next(error); }
});

async function getSessionsForUnitGroup(unitId, groupName) {
  const [sessions, unit, venues] = await Promise.all([
    collections.sessions.find({ unit_id: unitId, group_name: groupName }).toArray(),
    collections.units.findOne({ _id: unitId }),
    collections.venues.find().toArray()
  ]);
  if (!unit) return [];
  const venuesById = new Map(venues.map((venue) => [venue._id, venue]));
  return sessions.map((session) => ({
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
    venue: venuesById.get(session.venue_id)?.name || null
  }));
}

router.get('/changes', async (req, res, next) => {
  try {
    const selections = await collections.selections.find({ student_id: req.user.sub }).toArray();
    const units = selections.length
      ? await collections.units.find({ _id: { $in: selections.map((selection) => selection.unit_id) } }).toArray()
      : [];
    const codes = [...new Set(units.map((unit) => unit.code))];
    const query = { unit_code: { $in: codes } };
    if (req.query.since) query.recorded_at = { $gt: new Date(req.query.since) };
    const changes = codes.length
      ? await collections.timetableChanges.find(query).sort({ recorded_at: -1 }).limit(100).toArray()
      : [];
    res.json(changes.map(({ _id, ...change }) => ({ id: _id, ...change })));
  } catch (error) { next(error); }
});

router.get('/calendar.ics', async (req, res, next) => {
  try {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const sessions = await getSelectedSessions(req.user.sub, { from, to });
    const { expandSessions } = await import('../domain/clashes.js');
    const events = expandSessions(sessions, from, to).map((session) => {
      const start = session.start;
      const minutes = Math.round((session.end - session.start) / 60000);
      return {
        uid: `classday-${session.id}-${start.getTime()}@classday`,
        title: `${session.code}: ${session.name}${session.kind === 'exam' ? ' (Exam)' : ''}`,
        start: [start.getFullYear(), start.getMonth() + 1, start.getDate(), start.getHours(), start.getMinutes()],
        duration: { minutes },
        startInputType: 'local',
        startOutputType: 'local',
        location: session.venue || '',
        description: `${session.kind === 'exam' ? 'Exam' : 'Lecture'} · Group ${session.group_name}`
      };
    });
    createEvents(events, (error, value) => {
      if (error) return next(error);
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="student-planner-schedule.ics"');
      res.send(value);
    });
  } catch (error) { next(error); }
});

router.post('/admin/import', requireAdmin, express.raw({ type: () => true, limit: '12mb' }), async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Choose a timetable file to upload.' });
    const filename = decodeURIComponent(req.headers['x-file-name'] || 'timetable.csv');
    const rows = await parseTimetable(req.body, filename);
    res.json(await importTimetable(rows, filename, req.user.sub));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/admin/units/import', requireAdmin, express.raw({ type: () => true, limit: '12mb' }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Choose a units-offered file to upload.' });
    const filename = decodeURIComponent(req.headers['x-file-name'] || 'units.csv');
    const rows = await parseUnitOfferings(req.body, filename);
    res.json(await importUnitOfferings(rows, {
      syncProgramLinks: /\.pdf$/i.test(filename) && rows.some((row) => row.programCode)
    }));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/reminders', async (req, res, next) => {
  try {
    const preferences = await collections.reminderPreferences.findOne({ student_id: req.user.sub });
    res.json(preferences ? {
      exam_hours_before: preferences.exam_hours_before,
      class_minutes_before: preferences.class_minutes_before,
      enabled: preferences.enabled
    } : { exam_hours_before: 24, class_minutes_before: 60, enabled: true });
  } catch (error) { next(error); }
});

router.put('/reminders', async (req, res, next) => {
  try {
    const examHours = Math.max(1, Math.min(168, Number(req.body.exam_hours_before) || 24));
    const classMinutes = Math.max(5, Math.min(1440, Number(req.body.class_minutes_before) || 60));
    const enabled = Boolean(req.body.enabled);
    await collections.reminderPreferences.updateOne(
      { student_id: req.user.sub },
      {
        $set: { exam_hours_before: examHours, class_minutes_before: classMinutes, enabled },
        $setOnInsert: { _id: req.user.sub }
      },
      { upsert: true }
    );
    res.json({ exam_hours_before: examHours, class_minutes_before: classMinutes, enabled });
  } catch (error) { next(error); }
});

export { router as plannerRouter, getSelectedSessions };
