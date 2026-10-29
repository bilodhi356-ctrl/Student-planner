import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractPdfTimetable,
  pdfItemsToRecords,
  teachingTimetablePagesToRecords,
  yearSectionItemsToOfferings
} from './pdfTimetable.js';
import { parseTimetable } from './importTimetable.js';
import { parseUnitOfferings } from './unitOfferings.js';

function makePdf(rows) {
  const columnX = [20, 90, 180, 230, 290, 350, 420, 490, 560, 630];
  const content = rows.map((row, rowIndex) => row.map((text, columnIndex) => (
    `BT /F1 8 Tf 1 0 0 1 ${columnX[columnIndex]} ${700 - rowIndex * 20} Tm (${text}) Tj ET`
  )).join('\n')).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf);
}

const headings = ['course_code', 'unit_name', 'year', 'semester', 'type', 'start_time', 'end_time', 'venue', 'day', 'date'];

test('parses a text-based PDF table into timetable sessions', async () => {
  const rows = await parseTimetable(makePdf([
    headings,
    ['CSC204', 'Computer Science', '2', '1', 'lecture', '09:00', '10:00', 'Room 1', 'Monday', ''],
    ['MTH101', 'Calculus', '1', '1', 'exam', '13:00', '15:00', 'Hall 2', '', '2026-11-02']
  ]), 'timetable.pdf');

  assert.deepEqual(rows, [
    {
      code: 'CSC204',
      name: 'Computer Science',
      year: 2,
      semester: 1,
      programCode: null,
      programName: null,
      kind: 'lecture',
      group: 'A',
      dayOfWeek: 0,
      sessionDate: null,
      startTime: '09:00',
      endTime: '10:00',
      venue: 'Room 1',
      building: null,
      lecturerName: null
    },
    {
      code: 'MTH101',
      name: 'Calculus',
      year: 1,
      semester: 1,
      programCode: null,
      programName: null,
      kind: 'exam',
      group: 'A',
      dayOfWeek: undefined,
      sessionDate: '2026-11-02',
      startTime: '13:00',
      endTime: '15:00',
      venue: 'Hall 2',
      building: null,
      lecturerName: null
    }
  ]);
});

test('parses an optional lecturer name from the timetable upload', async () => {
  const rows = await parseTimetable(Buffer.from([
    'course_code,unit_name,year,semester,type,start_time,end_time,venue,day,instructor',
    'CSC204,Computer Science,2,1,lecture,09:00,10:00,Room 1,Monday,Dr Example'
  ].join('\n')), 'timetable.csv');

  assert.equal(rows[0].lecturerName, 'Dr Example');
});

test('parses a text-based PDF year-section list into offered units', async () => {
  const rows = await parseUnitOfferings(makePdf([
    ['COURSES FOR SEMESTER ONE'],
    ['YEAR TWO'],
    ['CSC 204', 'Computer Science', '', '', '', '', '1C', 'Lecturer']
  ]), 'units.pdf');

  assert.deepEqual(rows, [{
    code: 'CSC204',
    name: 'Computer Science',
    year: 2,
    semester: 1,
    programCode: null,
    programName: null,
    lecturerName: 'Lecturer'
  }]);
});

test('continues reading rows across pages with repeated table headings', () => {
  const pageOne = headings.map((text, index) => ({ page: 1, x: index * 10, y: 1, text }));
  const firstRow = ['CSC204', 'Computer Science', '2', '1', 'lecture', '09:00', '10:00', 'Room 1']
    .map((text, index) => ({ page: 1, x: index * 10, y: 2, text }));
  const pageTwo = headings.map((text, index) => ({ page: 2, x: index * 10, y: 1, text }));
  const secondRow = ['MTH101', 'Mathematics', '1', '2', 'lecture', '11:00', '12:00', 'Room 2']
    .map((text, index) => ({ page: 2, x: index * 10, y: 2, text }));

  assert.equal(pdfItemsToRecords([...pageOne, ...firstRow, ...pageTwo, ...secondRow]).length, 2);
});

test('reports scanned PDFs and PDFs without the required table headings', () => {
  assert.throws(() => pdfItemsToRecords([]), /no selectable text/i);
  assert.throws(() => pdfItemsToRecords([{ page: 1, x: 1, y: 1, text: 'Schedule' }]), /required timetable column headings/i);
});

test('reads year and semester headings from OCR words and extracts course columns', () => {
  const items = [
    { page: 1, pageWidth: 625, x: 200, x1: 260, y: 20, text: 'COURSES' },
    { page: 1, pageWidth: 625, x: 270, x1: 290, y: 20, text: 'FOR' },
    { page: 1, pageWidth: 625, x: 300, x1: 365, y: 20, text: 'SEMESTER' },
    { page: 1, pageWidth: 625, x: 370, x1: 410, y: 20, text: 'ONE' },
    { page: 1, pageWidth: 625, x: 60, x1: 110, y: 100, text: 'YEAR' },
    { page: 1, pageWidth: 625, x: 115, x1: 165, y: 100, text: 'ONE' },
    { page: 1, pageWidth: 625, x: 60, x1: 82, y: 130, text: 'CIR' },
    { page: 1, pageWidth: 625, x: 84, x1: 102, y: 130, text: '101' },
    { page: 1, pageWidth: 625, x: 135, x1: 185, y: 130, text: 'Discrete' },
    { page: 1, pageWidth: 625, x: 190, x1: 260, y: 130, text: 'Structures' },
    { page: 1, pageWidth: 625, x: 265, x1: 272, y: 130, text: 'I' },
    { page: 1, pageWidth: 625, x: 380, x1: 398, y: 130, text: '1C' },
    { page: 1, pageWidth: 625, x: 410, x1: 460, y: 130, text: 'SMASS' }
  ];

  assert.deepEqual(yearSectionItemsToOfferings(items), [{
    course_code: 'CIR101',
    unit_name: 'Discrete Structures I',
    year: '1',
    semester: '1',
    lecturer_name: 'SMASS'
  }]);
});

test('extracts lecturer assignments from allocation PDF rows', () => {
  const items = [
    { page: 1, pageWidth: 612, x: 200, y: 20, text: 'COURSES FOR SEMESTER ONE 2026/2027' },
    { page: 1, pageWidth: 612, x: 60, y: 100, text: 'YEAR ONE' },
    { page: 1, pageWidth: 612, x: 65, y: 120, text: 'CIR 103' },
    { page: 1, pageWidth: 612, x: 138, y: 120, text: 'Electrical Principles' },
    { page: 1, pageWidth: 612, x: 378, y: 120, text: '1C' },
    { page: 1, pageWidth: 612, x: 400, y: 120, text: 'Mr. Nyabundi (2)' }
  ];

  assert.deepEqual(yearSectionItemsToOfferings(items), [{
    course_code: 'CIR103',
    unit_name: 'Electrical Principles',
    year: '1',
    semester: '1',
    lecturer_name: 'Mr. Nyabundi'
  }]);
});

test('reads weekly teaching timetables from day, group, and hourly grid cells', () => {
  const times = ['7', '8', '9', '10', '11', '12', '1', '2', '3', '4', '5'];
  const x = [133, 195, 264, 324, 381, 441, 505, 555, 604, 658, 722];
  const firstPage = [
    { x: 350, y: 30, text: 'SEM 1 2026/2027' },
    ...times.map((text, index) => ({ x: x[index], y: 100, text })),
    { x: 56, y: 140, text: 'MON' },
    { x: 94, y: 140, text: 'CCS 1' },
    { x: 264, y: 140, text: 'CIR203A' },
    { x: 264, y: 154, text: '(TB2)' },
    { x: 324, y: 140, text: 'CIR203A' },
    { x: 324, y: 154, text: '(TB2)' },
    { x: 94, y: 168, text: 'CCT 1' },
    { x: 264, y: 168, text: 'CCT109 (TB3)' },
    { x: 56, y: 200, text: 'FRI' },
    { x: 94, y: 200, text: 'CCS 4' },
    { x: 264, y: 200, text: 'CIR401' }
  ].map((item) => ({ ...item, page: 1 }));
  const secondPage = [
    { x: 264, y: 30, text: '(TB2)' },
    { x: 94, y: 50, text: 'CCT 1' },
    { x: 324, y: 50, text: 'CIR405 (LAB 1)' }
  ].map((item) => ({ ...item, page: 2 }));

  const records = teachingTimetablePagesToRecords([
    { number: 1, items: firstPage },
    { number: 2, items: secondPage }
  ]);
  assert.ok(records);
  assert.deepEqual(records, [
    {
      course_code: 'CIR203A', unit_name: 'CIR203A', year: '1', semester: '1',
      type: 'lecture', day: 'monday', group: 'CCS 1', start_time: '09:00', end_time: '11:00', venue: 'TB2'
    },
    {
      course_code: 'CCT109', unit_name: 'CCT109', year: '1', semester: '1',
      type: 'lecture', day: 'monday', group: 'CCT 1', start_time: '09:00', end_time: '10:00', venue: 'TB3'
    },
    {
      course_code: 'CIR401', unit_name: 'CIR401', year: '4', semester: '1',
      type: 'lecture', day: 'friday', group: 'CCS 4', start_time: '09:00', end_time: '10:00', venue: 'TB2'
    },
    {
      course_code: 'CIR405', unit_name: 'CIR405', year: '1', semester: '1',
      type: 'lecture', day: 'friday', group: 'CCT 1', start_time: '10:00', end_time: '11:00', venue: 'LAB 1'
    }
  ]);
});
