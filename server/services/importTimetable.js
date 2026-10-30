import XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';
import { collections } from '../db/index.js';
import { parseUploadRecords } from './uploadRecords.js';

const required = ['course_code', 'unit_name', 'year', 'semester', 'type', 'start_time', 'end_time', 'venue'];
const days = new Map(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map((name, i) => [name, i]));
function cellTime(value) {
  if(value instanceof Date)return `${String(value.getHours()).padStart(2,'0')}:${String(value.getMinutes()).padStart(2,'0')}`;
  if (typeof value === 'number') {
    const minutes = Math.round(value * 24 * 60) % (24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!match) throw new Error(`Invalid time: ${text}`);
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 23 || (match[3] && (hour < 1 || hour > 12))) throw new Error(`Invalid time: ${text}`);
  if (match[3]) hour = (hour % 12) + (/PM/i.test(match[3]) ? 12 : 0);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function cellDate(value) {
  if(value instanceof Date)return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
  if (typeof value === 'number') return XLSX.SSF.format('yyyy-mm-dd', value);
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${text}`);
  return date.toISOString().slice(0, 10);
}

export async function parseTimetable(buffer, filename = 'timetable.csv') {
  const records = await parseUploadRecords(buffer, filename, required, 'timetable');
  return records.map((row, index) => {
    const kind = String(row.type).trim().toLowerCase().startsWith('exam') ? 'exam' : String(row.type).trim().toLowerCase().startsWith('lect') ? 'lecture' : '';
    if (!kind) throw new Error(`Row ${index + 2}: type must be lecture or exam.`);
    const code = String(row.course_code).trim().toUpperCase();
    const startTime = cellTime(row.start_time);
    const endTime = cellTime(row.end_time);
    if (startTime === endTime) throw new Error(`Row ${index + 2}: start and end times must differ.`);
    const dayLabel = String(row.day ?? '').trim().toLowerCase();
    const dayOfWeek = dayLabel ? days.get(dayLabel) ?? (/^[0-6]$/.test(dayLabel) ? Number(dayLabel) : undefined) : undefined;
    const sessionDate = row.date ? cellDate(row.date) : null;
    const year=Number(row.year),semester=Number(row.semester);
    const group = String(row.group || 'A').trim();
    const groupPrefix = group.match(/^(CCS|CCT)\s*[1-8]$/i)?.[1]?.toUpperCase();
    const inferredProgram = groupPrefix === 'CCS'
      ? { code: 'BSC-CS', name: 'BSc Computer Science' }
      : groupPrefix === 'CCT' ? { code: 'BSC-CT', name: 'BSc Computer Technology' } : null;
    if(!code||!String(row.unit_name).trim()||!String(row.venue).trim())throw new Error(`Row ${index+2}: course code, unit name, and venue are required.`);
    if(!Number.isInteger(year)||year<1||year>8||!Number.isInteger(semester)||semester<1||semester>3)throw new Error(`Row ${index+2}: year must be 1–8 and semester must be 1–3.`);
    if (kind === 'lecture' && dayOfWeek === undefined) throw new Error(`Row ${index + 2}: lectures need a valid day.`);
    if (kind === 'exam' && !sessionDate) throw new Error(`Row ${index + 2}: exams need a date.`);
    const parsed = {
      code, name: String(row.unit_name).trim(), year, semester,
      programCode:String(row.program_code||row.program||inferredProgram?.code||'').trim().toUpperCase()||null,
      programName:String(row.program_name||row.program||inferredProgram?.name||'').trim()||null,kind,
      group, dayOfWeek, sessionDate, startTime, endTime,
      venue: String(row.venue).trim(), building: String(row.building ?? '').trim() || null,
      lecturerName: String(row.lecturer_name ?? '').trim() || null
    };
    if (row.abbreviatedCourseCode) parsed.courseCodeAbbreviated = true;
    return parsed;
  });
}

function resolveOfferedCourseCode(code, programCode, coursesByProgram, abbreviated = false) {
  const offeredCodes = coursesByProgram.get(programCode) || [];
  if (offeredCodes.includes(code) && !abbreviated) return code;
  const number = code.match(/\d{3}/)?.[0];
  if (!number) return code;
  const candidates = offeredCodes.filter((candidate) => new RegExp(`${number}[A-Z]?$`).test(candidate));
  if (!candidates.length) return code;

  const preferredPrefix = programCode === 'BSC-CS' ? 'CCS' : programCode === 'BSC-CT' ? 'CCT' : null;
  const preferred = preferredPrefix ? candidates.filter((candidate) => candidate.startsWith(preferredPrefix)) : [];
  if (preferred.length === 1) return preferred[0];
  if (offeredCodes.includes(code)) return code;
  if (candidates.length === 1) return candidates[0];
  const sectionlessCode = code.replace(/[AB]$/i, '');
  if (candidates.includes(sectionlessCode)) return sectionlessCode;
  return code;
}

const identityKey = (row) => [row.code, row.kind, row.group, row.dayOfWeek ?? '', row.sessionDate ?? ''].join('|');
const sameSession = (a,b) => a.startTime===b.startTime&&a.endTime===b.endTime&&a.venue===b.venue&&a.lecturerName===b.lecturerName;

async function replaceSessionRows(rows, filename, adminId, replaceKind = null) {
  const units = await collections.units.find({ active: true }).toArray();
  const unitPrograms = await collections.unitPrograms.find().toArray();
  const programs = await collections.programs.find().toArray();
  const programCodes = new Map(programs.map((program) => [program._id, program.code]));
  const offeringResult = unitPrograms.flatMap((link) => {
    const unit = units.find((item) => item._id === link.unit_id);
    const programCode = programCodes.get(link.program_id);
    return unit && programCode ? [{ program_code: programCode, code: unit.code, name: unit.name }] : [];
  });
  const coursesByProgram = new Map();
  const unitNames = new Map();
  for (const offering of offeringResult) {
    const codes = coursesByProgram.get(offering.program_code) || [];
    codes.push(offering.code.toUpperCase());
    coursesByProgram.set(offering.program_code, codes);
    unitNames.set(offering.code.toUpperCase(), offering.name);
  }
  rows = rows.map((row) => {
    const originalCode = row.code.toUpperCase();
    const code = resolveOfferedCourseCode(originalCode, row.programCode, coursesByProgram, row.courseCodeAbbreviated);
    return {
      ...row,
      code,
      name: String(row.name).trim().toUpperCase() === originalCode
        ? unitNames.get(code) || code
        : row.name
    };
  });
  const [existingSessions, venues] = await Promise.all([
    collections.sessions.find().toArray(),
    collections.venues.find().toArray()
  ]);
  const currentKindSessions = replaceKind ? existingSessions.filter((session) => session.kind === replaceKind) : existingSessions;
  const unitById = new Map(units.map((unit) => [unit._id, unit]));
  const venueById = new Map(venues.map((venue) => [venue._id, venue]));
  const old = currentKindSessions.flatMap((session) => {
    const unit = unitById.get(session.unit_id);
    if (!unit) return [];
    return [{
      code: unit.code.toUpperCase(),
      kind: session.kind,
      group: session.group_name,
      dayOfWeek: session.day_of_week,
      sessionDate: session.session_date,
      startTime: session.start_time.slice(0, 5),
      endTime: session.end_time.slice(0, 5),
      venue: venueById.get(session.venue_id)?.name || '',
      lecturerName: session.lecturer_name || null
    }];
  });
  const groupByIdentity=(input)=>{
    const grouped=new Map();
    for(const row of input){const key=identityKey(row);const list=grouped.get(key)||[];list.push(row);grouped.set(key,list)}
    for(const list of grouped.values())list.sort((a,b)=>a.startTime.localeCompare(b.startTime));
    return grouped;
  };
  const oldGroups=groupByIdentity(old);
  const newGroups=groupByIdentity(rows);
  const importId = randomUUID();
  await collections.timetableImports.insertOne({
    _id: importId,
    uploaded_by: adminId,
    filename,
    row_count: rows.length,
    imported_at: new Date()
  });
  const allKeys=new Set([...oldGroups.keys(),...newGroups.keys()]);
  const changes = [];
  for(const key of allKeys){
    const previous=oldGroups.get(key)||[],next=newGroups.get(key)||[];
    const common=Math.min(previous.length,next.length);
    for(let index=0;index<common;index++)if(!sameSession(previous[index],next[index]))changes.push({
      _id: randomUUID(), import_id: importId, unit_code: next[index].code, change_type: 'changed',
      before_data: previous[index], after_data: next[index], recorded_at: new Date()
    });
    for(const prior of previous.slice(common))changes.push({
      _id: randomUUID(), import_id: importId, unit_code: prior.code, change_type: 'removed',
      before_data: prior, recorded_at: new Date()
    });
    for(const item of next.slice(common))changes.push({
      _id: randomUUID(), import_id: importId, unit_code: item.code, change_type: 'added',
      after_data: item, recorded_at: new Date()
    });
  }
  if (changes.length) await collections.timetableChanges.insertMany(changes);
  if (replaceKind) await collections.sessions.deleteMany({ kind: replaceKind });
  else await collections.sessions.deleteMany({});
  if (replaceKind === 'exam') await collections.reminderDeliveries.deleteMany({ reminder_kind: 'exam' });
  else await collections.reminderDeliveries.deleteMany({});
  for (const row of rows) {
    let programId = null;
    if (row.programCode) {
      await collections.programs.updateOne(
        { code: row.programCode },
        { $set: { name: row.programName || row.programCode }, $setOnInsert: { _id: randomUUID() } },
        { upsert: true }
      );
      programId = (await collections.programs.findOne({ code: row.programCode }))._id;
    }
    const existingUnit = await collections.units.findOne({ code: row.code });
    const unitId = existingUnit?._id || randomUUID();
    const unitDocument = {
      code: row.code,
      name: row.name === row.code && existingUnit ? existingUnit.name : row.name,
      year: row.year,
      semester: row.semester,
      program_id: programId || existingUnit?.program_id || null,
      lecturer_name: row.lecturerName || existingUnit?.lecturer_name || null,
      active: true
    };
    await collections.units.updateOne(
      { code: row.code },
      { $set: unitDocument, $setOnInsert: { _id: unitId } },
      { upsert: true }
    );
    if (programId) {
      await collections.unitPrograms.updateOne(
        { unit_id: unitId, program_id: programId },
        { $setOnInsert: { _id: `${unitId}:${programId}` } },
        { upsert: true }
      );
    }
    await collections.venues.updateOne(
      { name: row.venue },
      { $set: row.building ? { building: row.building } : {}, $setOnInsert: { _id: randomUUID(), name: row.venue } },
      { upsert: true }
    );
    const venue = await collections.venues.findOne({ name: row.venue });
    await collections.sessions.insertOne({
      _id: randomUUID(),
      unit_id: unitId,
      venue_id: venue._id,
      kind: row.kind,
      group_name: row.group,
      day_of_week: row.dayOfWeek ?? null,
      session_date: row.sessionDate,
      start_time: row.startTime,
      end_time: row.endTime,
      lecturer_name: row.lecturerName || existingUnit?.lecturer_name || null,
      created_at: new Date()
    });
  }
  const changed=[...allKeys].reduce((total,key)=>{const a=oldGroups.get(key)||[],b=newGroups.get(key)||[];return total+Array.from({length:Math.min(a.length,b.length)},(_,index)=>sameSession(a[index],b[index])?0:1).reduce((x,y)=>x+y,0)},0);
  return { importId, rowCount: rows.length, added: [...newGroups.entries()].reduce((n,[key,list])=>n+Math.max(0,list.length-(oldGroups.get(key)||[]).length),0), removed: [...oldGroups.entries()].reduce((n,[key,list])=>n+Math.max(0,list.length-(newGroups.get(key)||[]).length),0), changed };
}

export async function importTimetable(rows, filename, adminId) {
  try {
    return await replaceSessionRows(rows, filename, adminId);
  } catch (error) { throw error; }
}

export async function importExamTimetable(rows, filename, adminId) {
  try {
    const examRows = rows.filter((row) => String(row.kind || row.type || '').trim().toLowerCase().startsWith('exam'));
    if (!examRows.length) throw new Error('The uploaded exam timetable file has no exam rows.');
    if (examRows.length !== rows.length) throw new Error('Exam timetable uploads can only contain exam sessions.');
    return await replaceSessionRows(examRows, filename, adminId, 'exam');
  } catch (error) { throw error; }
}
