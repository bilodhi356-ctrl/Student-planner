import { pool } from '../db/index.js';
import { extractPdfUnitOfferings } from './pdfTimetable.js';
import { parseUploadRecords } from './uploadRecords.js';

const requiredColumns = ['course_code', 'unit_name', 'year', 'semester'];

function normalizePdfOfferings(records) {
  const byOffering = new Map();
  for (const row of records) {
    const code = String(row.course_code ?? '').trim().toUpperCase();
    const programCode = String(row.program_code ?? '').trim().toUpperCase() || '';
    const name = String(row.unit_name ?? '')
      .replace(/\s+(?:[1-9]\s*)?[CE]$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const offering = { ...row, course_code: code, unit_name: name };
    const key = `${programCode}|${code}`;
    const existing = byOffering.get(key);
    if (!existing) {
      byOffering.set(key, offering);
      continue;
    }

    if (String(existing.year) !== String(row.year) || String(existing.semester) !== String(row.semester)) {
      throw new Error(`Unit ${code} appears under multiple years or semesters in this PDF.`);
    }

    // Allocation PDFs can repeat a unit in multiple categories or include
    // neighboring row text. Keep the shortest clean title for each unit code.
    if (name.length && (!existing.unit_name || name.length < existing.unit_name.length)) {
      byOffering.set(key, offering);
    }
  }
  return [...byOffering.values()];
}

export async function parseUnitOfferings(buffer, filename = 'units.csv') {
  const isPdf = /\.pdf$/i.test(filename);
  const parsedRecords = isPdf
    ? await extractPdfUnitOfferings(buffer)
    : await parseUploadRecords(buffer, filename, requiredColumns, 'units offered');
  const records = isPdf ? normalizePdfOfferings(parsedRecords) : parsedRecords;
  const seenOfferings = new Set();
  const academicDetailsByCode = new Map();
  return records.map((row, index) => {
    const code = String(row.course_code ?? '').trim().toUpperCase();
    const name = String(row.unit_name ?? '').trim();
    const year = Number(row.year);
    const semester = Number(row.semester);
    const programCode = String(row.program_code || row.program || '').trim().toUpperCase() || null;
    const programName = String(row.program_name || row.program || '').trim() || null;

    if (!code || !name) throw new Error(`Row ${index + 2}: course code and unit name are required.`);
    if (!Number.isInteger(year) || year < 1 || year > 8) throw new Error(`Row ${index + 2}: year must be from 1 to 8.`);
    if (!Number.isInteger(semester) || semester < 1 || semester > 3) throw new Error(`Row ${index + 2}: semester must be from 1 to 3.`);
    const offeringKey = `${programCode || ''}|${code}`;
    if (seenOfferings.has(offeringKey)) throw new Error(`Row ${index + 2}: duplicate course code ${code} for this program.`);
    seenOfferings.add(offeringKey);
    const academicDetails = academicDetailsByCode.get(code);
    if (academicDetails && (academicDetails.year !== year || academicDetails.semester !== semester)) {
      throw new Error(`Course ${code} is assigned to different years or semesters across programs.`);
    }
    academicDetailsByCode.set(code, { year, semester });

    return { code, name, year, semester, programCode, programName };
  });
}

export async function importUnitOfferings(rows, { syncProgramLinks = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const programIds = new Map();
    for (const row of rows) {
      let programId = null;
      if (row.programCode) {
        const program = await client.query(`INSERT INTO programs(code,name) VALUES($1,$2)
          ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [row.programCode, row.programName || row.programCode]);
        programId = program.rows[0].id;
        programIds.set(row.programCode, programId);
      }
      const unit = await client.query(`INSERT INTO units(code,name,year,semester,program_id,active) VALUES($1,$2,$3,$4,$5,TRUE)
        ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,year=EXCLUDED.year,semester=EXCLUDED.semester,
        program_id=COALESCE(units.program_id,EXCLUDED.program_id),active=TRUE RETURNING id`,
      [row.code, row.name, row.year, row.semester, programId]);
      if (programId) await client.query(`INSERT INTO unit_programs(unit_id,program_id) VALUES($1,$2)
        ON CONFLICT(unit_id,program_id) DO NOTHING`, [unit.rows[0].id, programId]);
    }
    if (syncProgramLinks) {
      for (const [programCode, programId] of programIds) {
        const codes = [...new Set(rows.filter((row) => row.programCode === programCode).map((row) => row.code))];
        await client.query(`DELETE FROM unit_programs up USING units u
          WHERE up.unit_id=u.id AND up.program_id=$1 AND NOT (u.code = ANY($2::text[]))`, [programId, codes]);
      }
    }
    await client.query('COMMIT');
    return { rowCount: rows.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
