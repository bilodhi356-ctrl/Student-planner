import { parse } from 'csv-parse/sync';
import XLSX from 'xlsx';
import { pool } from '../db/index.js';

const required = ['course_code', 'unit_name', 'year', 'semester', 'type', 'start_time', 'end_time', 'venue'];
const days = new Map(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map((name, i) => [name, (i + 6) % 7]));
const header = (value) => String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

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

export function parseTimetable(buffer, filename = 'timetable.csv') {
  let records;
  if (/\.csv$/i.test(filename)) {
    records = parse(buffer, { columns: (columns) => columns.map(header), skip_empty_lines: true, trim: true, bom: true });
  } else if (/\.(xlsx|xls)$/i.test(filename)) {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const first = workbook.Sheets[workbook.SheetNames[0]];
    records = XLSX.utils.sheet_to_json(first, { defval: '' }).map((record) => Object.fromEntries(Object.entries(record).map(([key, value]) => [header(key), value])));
  } else throw new Error('Upload a .csv, .xlsx, or .xls timetable file.');
  if (!records.length) throw new Error('The uploaded timetable has no rows.');
  const headers = Object.keys(records[0]);
  const missing = required.filter((column) => !headers.includes(column));
  if (missing.length) throw new Error(`Missing columns: ${missing.join(', ')}`);
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
    if(!code||!String(row.unit_name).trim()||!String(row.venue).trim())throw new Error(`Row ${index+2}: course code, unit name, and venue are required.`);
    if(!Number.isInteger(year)||year<1||year>8||!Number.isInteger(semester)||semester<1||semester>3)throw new Error(`Row ${index+2}: year must be 1–8 and semester must be 1–3.`);
    if (kind === 'lecture' && dayOfWeek === undefined) throw new Error(`Row ${index + 2}: lectures need a valid day.`);
    if (kind === 'exam' && !sessionDate) throw new Error(`Row ${index + 2}: exams need a date.`);
    return {
      code, name: String(row.unit_name).trim(), year, semester, programCode:String(row.program_code||row.program||'').trim().toUpperCase()||null,
      programName:String(row.program_name||row.program||'').trim()||null,kind,
      group: String(row.group || 'A').trim(), dayOfWeek, sessionDate, startTime, endTime,
      venue: String(row.venue).trim(), building: String(row.building ?? '').trim() || null
    };
  });
}

const identityKey = (row) => [row.code, row.kind, row.group, row.dayOfWeek ?? '', row.sessionDate ?? ''].join('|');
const sameSession = (a,b) => a.startTime===b.startTime&&a.endTime===b.endTime&&a.venue===b.venue;

export async function importTimetable(rows, filename, adminId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const oldResult = await client.query(`SELECT u.code,s.kind,s.group_name,s.day_of_week,s.session_date::text,s.start_time::text,s.end_time::text,v.name venue FROM sessions s JOIN units u ON u.id=s.unit_id LEFT JOIN venues v ON v.id=s.venue_id`);
    const old = oldResult.rows.map((row) => ({ ...row, code: row.code.toUpperCase(), startTime: row.start_time.slice(0,5), endTime: row.end_time.slice(0,5), group: row.group_name, dayOfWeek: row.day_of_week, sessionDate: row.session_date, venue: row.venue || '' }));
    const groupByIdentity=(input)=>{
      const grouped=new Map();
      for(const row of input){const key=identityKey(row);const list=grouped.get(key)||[];list.push(row);grouped.set(key,list)}
      for(const list of grouped.values())list.sort((a,b)=>a.startTime.localeCompare(b.startTime));
      return grouped;
    };
    const oldGroups=groupByIdentity(old);
    const newGroups=groupByIdentity(rows);
    const imported = await client.query('INSERT INTO timetable_imports(uploaded_by,filename,row_count) VALUES($1,$2,$3) RETURNING id', [adminId, filename, rows.length]);
    const importId = imported.rows[0].id;
    const allKeys=new Set([...oldGroups.keys(),...newGroups.keys()]);
    for(const key of allKeys){
      const previous=oldGroups.get(key)||[],next=newGroups.get(key)||[];
      const common=Math.min(previous.length,next.length);
      for(let index=0;index<common;index++)if(!sameSession(previous[index],next[index]))await client.query(
        'INSERT INTO timetable_changes(import_id,unit_code,change_type,before_data,after_data) VALUES($1,$2,$3,$4,$5)',
        [importId,next[index].code,'changed',previous[index],next[index]]);
      for(const prior of previous.slice(common))await client.query('INSERT INTO timetable_changes(import_id,unit_code,change_type,before_data) VALUES($1,$2,$3,$4)',[importId,prior.code,'removed',prior]);
      for(const item of next.slice(common))await client.query('INSERT INTO timetable_changes(import_id,unit_code,change_type,after_data) VALUES($1,$2,$3,$4)',[importId,item.code,'added',item]);
    }
    await client.query('DELETE FROM sessions');
    for (const row of rows) {
      let programId=null;
      if(row.programCode){const program=await client.query(`INSERT INTO programs(code,name) VALUES($1,$2)
        ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[row.programCode,row.programName||row.programCode]);programId=program.rows[0].id}
      const unit = await client.query(`INSERT INTO units(code,name,year,semester,program_id) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,year=EXCLUDED.year,semester=EXCLUDED.semester,program_id=EXCLUDED.program_id RETURNING id`, [row.code,row.name,row.year,row.semester,programId]);
      const venue = await client.query(`INSERT INTO venues(name,building) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET building=COALESCE(EXCLUDED.building,venues.building) RETURNING id`, [row.venue,row.building]);
      await client.query(`INSERT INTO sessions(unit_id,venue_id,kind,group_name,day_of_week,session_date,start_time,end_time)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [unit.rows[0].id,venue.rows[0].id,row.kind,row.group,row.dayOfWeek,row.sessionDate,row.startTime,row.endTime]);
    }
    await client.query('COMMIT');
    const changed=[...allKeys].reduce((total,key)=>{const a=oldGroups.get(key)||[],b=newGroups.get(key)||[];return total+Array.from({length:Math.min(a.length,b.length)},(_,index)=>sameSession(a[index],b[index])?0:1).reduce((x,y)=>x+y,0)},0);
    return { importId, rowCount: rows.length, added: [...newGroups.entries()].reduce((n,[key,list])=>n+Math.max(0,list.length-(oldGroups.get(key)||[]).length),0), removed: [...oldGroups.entries()].reduce((n,[key,list])=>n+Math.max(0,list.length-(newGroups.get(key)||[]).length),0), changed };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
