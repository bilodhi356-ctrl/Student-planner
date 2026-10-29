import { randomUUID } from 'node:crypto';
import { collections } from '../db/index.js';
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
  try {
    const programIds = new Map();
    for (const row of rows) {
      let programId = null;
      if (row.programCode) {
        await collections.programs.updateOne(
          { code: row.programCode },
          { $set: { name: row.programName || row.programCode }, $setOnInsert: { _id: randomUUID() } },
          { upsert: true }
        );
        programId = (await collections.programs.findOne({ code: row.programCode }))._id;
        programIds.set(row.programCode, programId);
      }
      const existingUnit = await collections.units.findOne({ code: row.code });
      const unitId = existingUnit?._id || randomUUID();
      await collections.units.updateOne(
        { code: row.code },
        { $set: {
          name: row.name,
          year: row.year,
          semester: row.semester,
          program_id: existingUnit?.program_id || programId,
          active: true
        }, $setOnInsert: { _id: unitId } },
        { upsert: true }
      );
      if (programId) {
        await collections.unitPrograms.updateOne(
          { unit_id: unitId, program_id: programId },
          { $setOnInsert: { _id: `${unitId}:${programId}` } },
          { upsert: true }
        );
      }
    }
    if (syncProgramLinks) {
      for (const [programCode, programId] of programIds) {
        const codes = [...new Set(rows.filter((row) => row.programCode === programCode).map((row) => row.code))];
        const obsoleteUnits = await collections.units.find(
          { code: { $nin: codes } },
          { projection: { _id: 1 } }
        ).toArray();
        if (obsoleteUnits.length) {
          await collections.unitPrograms.deleteMany({
            program_id: programId,
            unit_id: { $in: obsoleteUnits.map((unit) => unit._id) }
          });
        }
      }
    }
    return { rowCount: rows.length };
  } catch (error) { throw error; }
}
