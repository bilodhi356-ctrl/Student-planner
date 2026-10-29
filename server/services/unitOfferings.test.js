import assert from 'node:assert/strict';
import test from 'node:test';
import XLSX from 'xlsx';
import { parseUnitOfferings } from './unitOfferings.js';

test('parses CSV offerings and normalizes course codes', async () => {
  const rows = await parseUnitOfferings(Buffer.from([
    'course_code,unit_name,year,semester,program_code,program_name',
    'csc204,Computer Science,2,1,BSC-CS,BSc Computer Science'
  ].join('\n')), 'units.csv');

  assert.deepEqual(rows, [{
    code: 'CSC204',
    name: 'Computer Science',
    year: 2,
    semester: 1,
    programCode: 'BSC-CS',
    programName: 'BSc Computer Science'
  }]);
});

test('parses an optional lecturer assignment from an allocation list', async () => {
  const rows = await parseUnitOfferings(Buffer.from([
    'course_code,unit_name,year,semester,lecturer_name',
    'CSC204,Computer Science,2,1,Dr Example'
  ].join('\n')), 'units.csv');

  assert.deepEqual(rows, [{
    code: 'CSC204',
    name: 'Computer Science',
    year: 2,
    semester: 1,
    programCode: null,
    programName: null,
    lecturerName: 'Dr Example'
  }]);
});

test('parses Excel offerings', async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet([{
    'Unit Code': 'MTH101',
    'Unit Name': 'Mathematics',
    Year: 1,
    Semester: 2
  }]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Units');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  assert.deepEqual(await parseUnitOfferings(buffer, 'units.xlsx'), [{
    code: 'MTH101',
    name: 'Mathematics',
    year: 1,
    semester: 2,
    programCode: null,
    programName: null
  }]);
});

test('rejects invalid year, semester, and duplicate course codes', async () => {
  await assert.rejects(
    parseUnitOfferings(Buffer.from('course_code,unit_name,year,semester\nCSC204,Computer Science,9,1'), 'units.csv'),
    /year must be from 1 to 8/
  );
  await assert.rejects(
    parseUnitOfferings(Buffer.from('course_code,unit_name,year,semester\nCSC204,Computer Science,2,4'), 'units.csv'),
    /semester must be from 1 to 3/
  );
  await assert.rejects(
    parseUnitOfferings(Buffer.from('course_code,unit_name,year,semester\nCSC204,Computer Science,2,1\ncsc204,Computer Science II,2,1'), 'units.csv'),
    /duplicate course code CSC204/
  );
});
