import { parse } from 'csv-parse/sync';
import XLSX from 'xlsx';
import { extractPdfRecords } from './pdfTimetable.js';

const columnAliases = new Map([
  ['course', 'course_code'],
  ['unit_code', 'course_code'],
  ['unit', 'course_code'],
  ['course_name', 'unit_name'],
  ['session_type', 'type'],
  ['lecturer', 'lecturer_name'],
  ['instructor', 'lecturer_name'],
  ['instructor_name', 'lecturer_name'],
  ['room', 'venue']
]);

const header = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return columnAliases.get(normalized) || normalized;
};

export async function parseUploadRecords(buffer, filename, requiredColumns, tableLabel) {
  let records;
  if (/\.csv$/i.test(filename)) {
    records = parse(buffer, { columns: (columns) => columns.map(header), skip_empty_lines: true, trim: true, bom: true });
  } else if (/\.(xlsx|xls)$/i.test(filename)) {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const first = workbook.Sheets[workbook.SheetNames[0]];
    if (!first) throw new Error('The Excel file does not contain a worksheet.');
    records = XLSX.utils.sheet_to_json(first, { defval: '' }).map((record) => Object.fromEntries(
      Object.entries(record).map(([key, value]) => [header(key), value])
    ));
  } else if (/\.pdf$/i.test(filename)) {
    records = await extractPdfRecords(buffer, requiredColumns, tableLabel);
  } else {
    throw new Error('Upload a .csv, .xlsx, .xls, or text-based .pdf file.');
  }

  if (!records.length) throw new Error(`The uploaded ${tableLabel} file has no rows.`);
  const headers = Object.keys(records[0]);
  const missing = requiredColumns.filter((column) => !headers.includes(column));
  if (missing.length) throw new Error(`Missing ${tableLabel} columns: ${missing.join(', ')}`);
  return records;
}
