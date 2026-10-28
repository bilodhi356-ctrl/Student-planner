import { createCanvas, loadImage } from 'canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createWorker } from 'tesseract.js';

const timetableColumns = ['course_code', 'unit_name', 'year', 'semester', 'type', 'start_time', 'end_time', 'venue'];
const yearLabels = new Map([
  ['ONE', 1], ['TWO', 2], ['THREE', 3], ['FOUR', 4],
  ['FIVE', 5], ['SIX', 6], ['SEVEN', 7], ['EIGHT', 8]
]);
const maximumOcrPages = 20;
const columnAliases = new Map([
  ['course_code', 'course_code'],
  ['course', 'course_code'],
  ['unit_code', 'course_code'],
  ['unit', 'course_code'],
  ['unit_name', 'unit_name'],
  ['course_name', 'unit_name'],
  ['program_code', 'program_code'],
  ['program_name', 'program_name'],
  ['program', 'program'],
  ['year', 'year'],
  ['semester', 'semester'],
  ['type', 'type'],
  ['session_type', 'type'],
  ['day', 'day'],
  ['date', 'date'],
  ['start_time', 'start_time'],
  ['end_time', 'end_time'],
  ['venue', 'venue'],
  ['room', 'venue'],
  ['group', 'group'],
  ['building', 'building']
]);

function normalizeHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function groupLines(items, yTolerance = 0.35) {
  const sorted = [...items].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const lines = [];
  for (const item of sorted) {
    let line = lines.at(-1);
    if (!line || line.page !== item.page || Math.abs(line.y - item.y) > yTolerance) {
      line = { page: item.page, y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }
  return lines;
}

function getCourseCode(line) {
  const text = line.items.map((item) => item.text).join(' ');
  const match = text.match(/\b([A-Z]{2,5})\s+(\d{3}[A-Z]?)\b/i);
  if (!match) return null;

  const start = match.index;
  const end = start + match[0].length;
  let position = 0;
  let codeEnd = null;
  for (const item of line.items) {
    const itemStart = position;
    const itemEnd = itemStart + item.text.length;
    if (itemStart < end && itemEnd >= end) codeEnd = item.x1 ?? item.x + item.text.length;
    position = itemEnd + 1;
  }
  if (codeEnd === null) return null;

  return {
    code: `${match[1]}${match[2]}`.toUpperCase(),
    end: codeEnd
  };
}

function extractYear(line) {
  const text = line.items.map((item) => item.text).join(' ');
  return yearFromText(text);
}

function yearFromText(text) {
  const tokens = String(text).toUpperCase().match(/[A-Z]+|[1-8]/g) || [];
  if (!tokens.includes('YEAR')) return null;
  const label = tokens.find((token) => yearLabels.has(token) || /^[1-8]$/.test(token));
  if (!label) return null;
  return yearLabels.get(label) || Number(label);
}

function extractSemester(items) {
  const text = items.map((item) => item.text).join(' ').toUpperCase();
  const match = text.match(/\bSEM(?:ESTER)?\s*(ONE|TWO|THREE|[1-3])\b/);
  if (!match) return null;
  return yearLabels.get(match[1]) || Number(match[1]);
}

function addOcrWords(items, data, pageNumber, pageWidth, offsetY = 0) {
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          if (word.confidence > 10 && word.text.trim()) {
            items.push({
              page: pageNumber,
              pageWidth,
              x: word.bbox.x0,
              x1: word.bbox.x1,
              y: (word.bbox.y0 + word.bbox.y1) / 2 + offsetY,
              text: word.text
            });
          }
        }
      }
    }
  }
}

function greenHeadingBands(canvas) {
  const { width, height } = canvas;
  const context = canvas.getContext('2d');
  const pixels = context.getImageData(0, 0, width, height).data;
  const bands = [];
  let bandStart = null;
  let lastGreenRow = null;
  for (let y = 0; y < height; y++) {
    let greenPixels = 0;
    for (let x = 0; x < width * 0.3; x++) {
      const index = (y * width + x) * 4;
      if (pixels[index + 1] > 170 && pixels[index] < 100 && pixels[index + 2] < 100) greenPixels++;
    }
    if (greenPixels >= 8) {
      if (bandStart === null) bandStart = y;
      lastGreenRow = y;
    } else if (bandStart !== null && y - lastGreenRow > 4) {
      bands.push([Math.max(0, bandStart - 12), Math.min(height, lastGreenRow + 13)]);
      bandStart = null;
      lastGreenRow = null;
    }
  }
  if (bandStart !== null) bands.push([Math.max(0, bandStart - 12), Math.min(height, lastGreenRow + 13)]);
  return bands;
}

function thresholdCanvas(sourceCanvas, threshold = 100) {
  const canvas = createCanvas(sourceCanvas.width, sourceCanvas.height);
  const context = canvas.getContext('2d');
  context.drawImage(sourceCanvas, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const luminance = pixels.data[index] * 0.299 + pixels.data[index + 1] * 0.587 + pixels.data[index + 2] * 0.114;
    const value = luminance < threshold ? 0 : 255;
    pixels.data[index] = value;
    pixels.data[index + 1] = value;
    pixels.data[index + 2] = value;
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

function findGridRows(canvas) {
  const { width, height } = canvas;
  const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const borderRows = [];
  for (let y = 0; y < height; y++) {
    let darkPixels = 0;
    for (let x = Math.floor(width * 0.08); x < width * 0.86; x++) {
      const index = (y * width + x) * 4;
      if (pixels[index] < 100 && pixels[index + 1] < 100 && pixels[index + 2] < 100) darkPixels++;
    }
    if (darkPixels > width * 0.4) borderRows.push(y);
  }

  const borders = [];
  for (const y of borderRows) {
    const previous = borders.at(-1);
    if (!previous || y > previous.bottom + 1) borders.push({ top: y, bottom: y });
    else previous.bottom = y;
  }
  const horizontalBorders = borders.filter((border) => border.bottom - border.top < 10);
  const rows = [];
  for (let index = 0; index < horizontalBorders.length - 1; index++) {
    const top = horizontalBorders[index].bottom + 4;
    const bottom = horizontalBorders[index + 1].top - 4;
    if (bottom - top >= 18 && bottom - top <= 80) rows.push({ top, bottom });
  }
  if (!rows.length) return null;

  const bounds = horizontalBorders.flatMap((border) => {
    let left = width;
    let right = 0;
    for (let y = border.top; y <= border.bottom; y++) {
      for (let x = Math.floor(width * 0.08); x < width * 0.86; x++) {
        const index = (y * width + x) * 4;
        if (pixels[index] < 100 && pixels[index + 1] < 100 && pixels[index + 2] < 100) {
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
      }
    }
    return right > left ? [{ left, right }] : [];
  }).sort((a, b) => a.left - b.left);
  if (!bounds.length) return null;
  const left = bounds[Math.floor(bounds.length / 2)].left;
  const right = bounds[Math.floor(bounds.length / 2)].right;
  const tableWidth = right - left;

  function verticalScore(x) {
    let score = 0;
    for (const row of rows) {
      let darkRows = 0;
      for (let y = row.top; y < row.bottom; y++) {
        let isDark = false;
        for (let offset = -1; offset <= 1; offset++) {
          const index = (y * width + x + offset) * 4;
          if (pixels[index] < 200 && pixels[index + 1] < 200 && pixels[index + 2] < 200) {
            isDark = true;
            break;
          }
        }
        if (isDark) darkRows++;
      }
      if (darkRows > (row.bottom - row.top) * 0.55) score++;
    }
    return score;
  }

  function findColumnBoundary(startRatio, endRatio, fallbackRatio) {
    const start = Math.round(left + tableWidth * startRatio);
    const end = Math.round(left + tableWidth * endRatio);
    let bestX = start;
    let bestScore = -1;
    for (let x = start; x <= end; x++) {
      const score = verticalScore(x);
      if (score > bestScore) {
        bestX = x;
        bestScore = score;
      }
    }
    return bestScore >= rows.length * 0.4 ? bestX : Math.round(left + tableWidth * fallbackRatio);
  }

  return {
    rows,
    left,
    codeBoundary: findColumnBoundary(0.12, 0.18, 0.15),
    nameBoundary: findColumnBoundary(0.65, 0.73, 0.69)
  };
}

function findOcrCourseCode(text) {
  return String(text).toUpperCase().match(/\b([A-Z]{2,5})\W{0,8}(\d{3})([A-Z]?)\b/);
}

async function recognizeCell(worker, canvas, left, top, right, bottom, pageMode, characterWhitelist = '', normalizeHighlights = true) {
  const crop = createCanvas(right - left, bottom - top);
  const context = crop.getContext('2d');
  context.drawImage(canvas, left, top, right - left, bottom - top, 0, 0, right - left, bottom - top);
  const image = context.getImageData(0, 0, crop.width, crop.height);
  let highlightedPixels = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    const red = image.data[index];
    const green = image.data[index + 1];
    const blue = image.data[index + 2];
    if (red > 100 && blue > 100 && green < 100 && Math.abs(red - blue) < 80) highlightedPixels++;
  }
  if (normalizeHighlights && highlightedPixels > crop.width * crop.height * 0.01) {
    for (let index = 0; index < image.data.length; index += 4) {
      const red = image.data[index];
      const green = image.data[index + 1];
      const blue = image.data[index + 2];
      const value = red * 0.299 + green * 0.587 + blue * 0.114 < 65 ? 0 : 255;
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
    }
    context.putImageData(image, 0, 0);
  }
  await worker.setParameters({
    tessedit_pageseg_mode: pageMode,
    tessedit_char_whitelist: characterWhitelist
  });
  const { data } = await worker.recognize(crop.toBuffer('image/png'));
  return data.text.trim();
}

async function extractGridOfferings(canvas, worker, pageNumber, yearHeadings) {
  const grid = findGridRows(canvas);
  if (!grid) return [];
  const offerings = [];
  const cellInset = Math.round(canvas.width * 0.027);
  for (const row of grid.rows) {
    const y = (row.top + row.bottom) / 2;
    const year = yearHeadings.filter((heading) => heading.y < y).at(-1)?.year;
    if (!year) continue;

    let codeText = await recognizeCell(
      worker,
      canvas,
      grid.left + 1,
      Math.max(0, row.top - 10),
      grid.codeBoundary - cellInset,
      Math.min(canvas.height, row.bottom + 14),
      '7',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    );
    let codeMatch = findOcrCourseCode(codeText);
    if (!codeMatch) {
      codeText = await recognizeCell(
        worker,
        canvas,
        grid.left + 1,
        Math.max(0, row.top - 10),
        grid.codeBoundary - cellInset,
        Math.min(canvas.height, row.bottom + 14),
        '8',
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        false
      );
      codeMatch = findOcrCourseCode(codeText);
    }
    let nameText = await recognizeCell(
      worker,
      canvas,
      grid.codeBoundary - cellInset,
      Math.max(0, row.top - 10),
      grid.nameBoundary - 7,
      Math.min(canvas.height, row.bottom + 14),
      '6',
      '',
      false
    );
    if (!codeMatch) {
      codeText = await recognizeCell(
        worker,
        canvas,
        grid.left + 1,
        Math.max(0, row.top - 10),
        grid.codeBoundary - 2,
        Math.min(canvas.height, row.bottom + 14),
        '7',
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
      );
      codeMatch = findOcrCourseCode(codeText);
    }
    let rowText = '';
    if (!codeMatch) {
      rowText = await recognizeCell(
        worker,
        canvas,
        grid.left + 1,
        Math.max(0, row.top - 12),
        grid.nameBoundary - 7,
        Math.min(canvas.height, row.bottom + 12),
        '6'
      );
      codeMatch = findOcrCourseCode(rowText);
    }
    const nameSource = nameText || rowText;
    const name = nameSource
      .replace(/[\r\n]+/g, ' ')
      .replace(/\b[A-Z]{2,5}\W{0,8}\d{3}[A-Z]?\b/gi, ' ')
      .replace(/^\s*\d{3}[A-Z]?\s*/i, ' ')
      .replace(/^[|¦\s]+|[|¦\s]+$/g, '')
      .replace(/\s*[|¦]\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!codeMatch || !name) {
      throw new Error(`Could not reliably read row ${offerings.length + 1} near y=${row.top} (code: ${JSON.stringify(codeText)}, name: ${JSON.stringify(nameText)}, row: ${JSON.stringify(rowText)}).`);
    }
    const suffix = codeMatch[3] && name.startsWith(codeMatch[3]) ? '' : codeMatch[3] || '';
    offerings.push({
      course_code: `${codeMatch[1]}${codeMatch[2]}${suffix}`,
      unit_name: name,
      year: String(year)
    });
  }
  return offerings;
}

export function yearSectionItemsToOfferings(items) {
  if (!items.length) throw new Error('This PDF contains no selectable text.');
  const semester = extractSemester(items);
  if (!semester) throw new Error('Could not find a semester heading such as “SEMESTER ONE” in the PDF.');

  const isOcr = items.some((item) => item.x1 !== undefined);
  const lines = groupLines(items, isOcr ? 14 : 1.5);
  const courseLines = [];
  for (const line of lines) {
    const course = getCourseCode(line);
    if (course) courseLines.push({ line, course });
  }
  const pageWidth = items[0].pageWidth;
  const recognizedCategoryPositions = courseLines.flatMap(({ line }) => line.items
    .filter((item) => /^(?:[1-9]\s*)?C$|^[ER]$/i.test(item.text.trim())
      && item.x / item.pageWidth > 0.5 && item.x / item.pageWidth < 0.8)
    .map((item) => item.x));
  const binWidth = pageWidth * 0.015;
  const categoryBins = new Map();
  for (const { line } of courseLines) {
    for (const item of line.items) {
      if (item.x / item.pageWidth >= 0.54 && item.x / item.pageWidth <= 0.65) {
        const bin = Math.floor(item.x / binWidth);
        const positions = categoryBins.get(bin) || [];
        positions.push(item.x);
        categoryBins.set(bin, positions);
      }
    }
  }
  const categoryBin = [...categoryBins.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!recognizedCategoryPositions.length && !categoryBin) {
    throw new Error('Could not identify the course table columns in this PDF.');
  }
  const categoryPositions = (recognizedCategoryPositions.length ? recognizedCategoryPositions : categoryBin[1]).sort((a, b) => a - b);
  const categoryX = categoryPositions[Math.floor(categoryPositions.length / 2)];
  const offerings = [];
  let currentYear = null;
  let currentProgram = null;
  let previousOffering = null;
  let yearHeadings = 0;

  for (const line of lines) {
    const heading = line.items.map((item) => item.text).join(' ').toUpperCase();
    if (!getCourseCode(line) && /\bBSC\s+COMPUTER\s+SCIENCE\b/.test(heading)) {
      currentProgram = { code: 'BSC-CS', name: 'BSc Computer Science' };
      previousOffering = null;
      continue;
    }
    if (!getCourseCode(line) && /\bCOMPUTER\s+TECHNOLOGY\b/.test(heading)) {
      currentProgram = { code: 'BSC-CT', name: 'BSc Computer Technology' };
      previousOffering = null;
      continue;
    }

    const year = extractYear(line);
    if (year) {
      currentYear = year;
      yearHeadings++;
      previousOffering = null;
      continue;
    }

    const parsedCourse = getCourseCode(line);
    if (parsedCourse) {
      if (!currentYear) throw new Error('Could not find a YEAR ONE, YEAR TWO, or similar heading before the course rows.');
      const name = line.items
        .filter((item) => item.x > parsedCourse.end && item.x < categoryX)
        .map((item) => item.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!name) continue;
      const offering = {
        course_code: parsedCourse.code,
        unit_name: name,
        year: String(currentYear),
        semester: String(semester),
        ...(currentProgram ? {
          program_code: currentProgram.code,
          program_name: currentProgram.name
        } : {})
      };
      offerings.push(offering);
      previousOffering = { offering, page: line.page, y: line.y };
      continue;
    }

    if (previousOffering && line.page === previousOffering.page && line.y - previousOffering.y <= 32) {
      const continuation = line.items
        .filter((item) => item.x > item.pageWidth * 0.15 && item.x < categoryX)
        .map((item) => item.text)
        .join(' ')
        .trim();
      if (continuation) {
        previousOffering.offering.unit_name = `${previousOffering.offering.unit_name} ${continuation}`.trim();
        previousOffering.y = line.y;
      }
    }
  }

  if (!yearHeadings) throw new Error('Could not find year-section headings such as “YEAR ONE” in the PDF.');
  if (!offerings.length) throw new Error('No course rows were found under the year headings in the PDF.');
  return offerings;
}

const timetableDayNames = new Map([
  ['MON', 'monday'], ['TUE', 'tuesday'], ['WED', 'wednesday'], ['THU', 'thursday'],
  ['FRI', 'friday'], ['SAT', 'saturday'], ['SUN', 'sunday']
]);

function findTimeColumns(items) {
  for (const line of groupLines(items.filter((item) => item.y < 180 && item.x > 120), 2)) {
    const values = line.items.sort((a, b) => a.x - b.x);
    for (let start = 0; start <= values.length - 11; start++) {
      const candidates = values.slice(start, start + 11);
      if (candidates.map((item) => item.text.trim()).join(',') !== '7,8,9,10,11,12,1,2,3,4,5') continue;
      return candidates.map((item, index) => ({
        x: item.x,
        startTime: `${String(index + 7).padStart(2, '0')}:00`
      }));
    }
  }
  return null;
}

function courseCodeFromText(text) {
  const value = String(text).toUpperCase().split('(')[0];
  const full = value.match(/\b([A-Z]{2,5})\s*(\d{3})\s*([A-Z]?)\b/);
  if (full) return { code: `${full[1]}${full[2]}${full[3]}`, abbreviated: false };
  const abbreviated = value.match(/\b(\d{3})\s*([A-Z]?)\b/);
  if (abbreviated) return { code: `${abbreviated[1]}${abbreviated[2]}`, abbreviated: true };
  return null;
}

function inferCourseCode(shortCode, row, candidates) {
  const digits = shortCode.match(/^\d+/)?.[0];
  const suffixMatches = candidates.filter((candidate) => candidate.endsWith(shortCode));
  if (suffixMatches.length === 1) return suffixMatches[0];

  const baseMatches = candidates.filter((candidate) => candidate.match(/\d+/)?.[0] === digits);
  const prefixes = [...new Set(baseMatches.map((candidate) => candidate.match(/^[A-Z]+/)?.[0]).filter(Boolean))];
  if (prefixes.length === 1) return `${prefixes[0]}${shortCode}`;

  const hundred = Math.floor(Number(digits) / 100) * 100;
  const seriesPrefixes = [...new Set(candidates
    .filter((candidate) => {
      const codePrefix = candidate.match(/^[A-Z]+/)?.[0];
      const codeNumber = Number(candidate.match(/\d+/)?.[0]);
      return ['CCS', 'CCT', 'CIR'].includes(codePrefix) && Math.floor(codeNumber / 100) * 100 === hundred;
    })
    .map((candidate) => candidate.match(/^[A-Z]+/)?.[0]))];
  if (hundred === 300 && seriesPrefixes.includes('CCT')) return `CCT${shortCode}`;
  if (hundred === 400 && seriesPrefixes.includes('CIR')) return `CIR${shortCode}`;
  if (hundred === 200 && row.program === 'CCT' && seriesPrefixes.includes('CCT')) return `CCT${shortCode}`;
  if (seriesPrefixes.length === 1) return `${seriesPrefixes[0]}${shortCode}`;

  const prefix = Number(digits) >= 300
    ? (Number(digits) >= 400 ? 'CIR' : 'CCT')
    : Number(digits) >= 200 ? 'CIR' : row.program;
  return `${prefix}${shortCode}`;
}

function cellVenue(text) {
  const matches = [...text.matchAll(/\(([^)]*)\)/g)].map((match) => match[1].replace(/\s+/g, ' ').trim()).filter(Boolean);
  return matches.join(' / ') || 'Unspecified';
}

function timetableRecordsForRow(row, columns, fullCourseCodes, sameTimeCourseCodes) {
  const cells = new Map();
  for (const item of row.items) {
    const index = columns.reduce((closest, column, candidate) => (
      Math.abs(item.x - column.x) < Math.abs(item.x - columns[closest].x) ? candidate : closest
    ), 0);
    const values = cells.get(index) || [];
    values.push(item);
    cells.set(index, values);
  }

  const slots = [];
  for (const [index, cellItems] of cells) {
    const text = cellItems
      .sort((a, b) => (a.page ?? row.page) - (b.page ?? row.page) || a.y - b.y || a.x - b.x)
      .map((item) => item.text.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const parsed = courseCodeFromText(text);
    if (!parsed) continue;
    const sameTimeCandidates = sameTimeCourseCodes.get(`${row.day}|${index}|${parsed.code}`) || [];
    const code = parsed.abbreviated
      ? sameTimeCandidates.length === 1
        ? sameTimeCandidates[0]
        : inferCourseCode(parsed.code, row, fullCourseCodes)
      : parsed.code;
    slots.push({
      index,
      code,
      abbreviated: parsed.abbreviated,
      venue: cellVenue(text),
      startTime: columns[index].startTime
    });
  }

  const sessions = [];
  for (const slot of slots.sort((a, b) => a.index - b.index)) {
    const previous = sessions.at(-1);
    const endTime = `${String(Number(slot.startTime.slice(0, 2)) + 1).padStart(2, '0')}:00`;
    if (previous && previous.lastSlotIndex + 1 === slot.index
      && previous.course_code === slot.code && previous.venue === slot.venue) {
      previous.end_time = endTime;
      previous.lastSlotIndex = slot.index;
      previous.abbreviatedCourseCode ||= slot.abbreviated;
      continue;
    }
    const session = {
      course_code: slot.code,
      unit_name: slot.code,
      year: String(row.year),
      semester: String(row.semester),
      type: 'lecture',
      day: row.day,
      group: row.group,
      start_time: slot.startTime,
      end_time: endTime,
      venue: slot.venue,
      lastSlotIndex: slot.index
    };
    Object.defineProperty(session, 'abbreviatedCourseCode', {
      value: slot.abbreviated,
      writable: true,
      enumerable: false
    });
    sessions.push(session);
  }
  for (const session of sessions) delete session.lastSlotIndex;
  return sessions;
}

function findEditableTimetableColumns(items) {
  for (const line of groupLines(items.filter((item) => item.y < 155 && item.x > 70), 2)) {
    const values = [...line.items].sort((a, b) => a.x - b.x);
    const labels = [];
    for (let index = 0; index < values.length; index++) {
      const combined = values[index].text.trim().match(/^(\d{1,2})\s*[–—-]\s*(\d{1,2})$/);
      if (combined) {
        labels.push({ start: Number(combined[1]), end: Number(combined[2]), x: values[index].x });
        continue;
      }
      const start = Number(values[index].text.trim());
      if (!Number.isInteger(start) || !values[index + 1] || !values[index + 2]) continue;
      if (!/^[–—-]$/.test(values[index + 1].text.trim())) continue;
      const end = Number(values[index + 2].text.trim());
      if (!Number.isInteger(end)) continue;
      labels.push({ start, end, x: values[index].x });
      index += 2;
    }
    const displayToHour = (value) => value <= 6 ? value + 12 : value;
    const columns = labels
      .filter((label) => displayToHour(label.end) === displayToHour(label.start) + 1)
      .map((label) => ({ x: label.x, hour: displayToHour(label.start) }))
      .sort((a, b) => a.x - b.x);
    if (columns.length === 11 && columns.every((column, index) => column.hour === index + 7)) {
      return columns.map((column) => ({ x: column.x, startTime: `${String(column.hour).padStart(2, '0')}:00` }));
    }
  }
  return null;
}

function editableTeachingTimetablePagesToRecords(pages) {
  const allItems = pages.flatMap((page) => page.items);
  const columns = findEditableTimetableColumns(pages[0]?.items || []);
  if (!columns) return null;
  const semester = extractSemester(allItems);
  if (!semester) throw new Error('Could not find the semester in the teaching timetable PDF.');

  const days = new Map([
    ['MONDAY', 'monday'], ['TUESDAY', 'tuesday'], ['WEDNESDAY', 'wednesday'],
    ['THURSDAY', 'thursday'], ['FRIDAY', 'friday'], ['SATURDAY', 'saturday'], ['SUNDAY', 'sunday']
  ]);
  const dayIndexes = new Map([...timetableDayNames.values()].map((day, index) => [day, index]));
  const slots = [];
  let matchedPages = 0;

  for (const page of pages) {
    const dayHeading = page.items.find((item) => item.y < 115 && days.has(item.text.trim().toUpperCase()));
    if (!dayHeading) continue;
    const day = days.get(dayHeading.text.trim().toUpperCase());
    const labels = page.items
      .filter((item) => item.x < 80 && /^(CCS|CCT)\s*[1-4]$/i.test(item.text.trim()))
      .sort((a, b) => a.y - b.y);
    if (!labels.length) continue;
    matchedPages++;

    for (const label of labels) {
      const [, program, year] = label.text.trim().toUpperCase().match(/^(CCS|CCT)\s*([1-4])$/);
      const rowItems = page.items.filter((item) => item.x >= columns[0].x - 30
        && Math.abs(item.y - label.y) <= 17);
      const cells = new Map();
      for (const item of rowItems) {
        const columnIndex = columns.reduce((closest, column, candidate) => (
          Math.abs(item.x - column.x) < Math.abs(item.x - columns[closest].x) ? candidate : closest
        ), 0);
        const items = cells.get(columnIndex) || [];
        items.push(item);
        cells.set(columnIndex, items);
      }

      for (const [columnIndex, cellItems] of cells) {
        const text = cellItems.sort((a, b) => a.y - b.y || a.x - b.x)
          .map((item) => item.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
        const parsed = courseCodeFromText(text);
        if (!parsed || parsed.abbreviated) continue;
        slots.push({
          code: parsed.code,
          group: `${program} ${year}`,
          year: Number(year),
          semester,
          day,
          dayOfWeek: dayIndexes.get(day),
          programCode: program === 'CCS' ? 'BSC-CS' : 'BSC-CT',
          programName: program === 'CCS' ? 'BSc Computer Science' : 'BSc Computer Technology',
          venue: cellVenue(text),
          startTime: columns[columnIndex].startTime,
          endTime: `${String(Number(columns[columnIndex].startTime.slice(0, 2)) + 1).padStart(2, '0')}:00`
        });
      }
    }
  }

  if (!matchedPages || !slots.length) return null;
  slots.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.group.localeCompare(b.group)
    || a.startTime.localeCompare(b.startTime));
  const sessions = [];
  for (const slot of slots) {
    const previous = sessions.at(-1);
    if (previous && previous.dayOfWeek === slot.dayOfWeek && previous.group === slot.group
      && previous.end_time === slot.startTime && previous.course_code === slot.code && previous.venue === slot.venue) {
      previous.end_time = slot.endTime;
      continue;
    }
    sessions.push({
      course_code: slot.code,
      unit_name: slot.code,
      program_code: slot.programCode,
      program_name: slot.programName,
      year: String(slot.year),
      semester: String(slot.semester),
      type: 'lecture',
      day: slot.day,
      dayOfWeek: slot.dayOfWeek,
      group: slot.group,
      start_time: slot.startTime,
      end_time: slot.endTime,
      venue: slot.venue
    });
  }
  return sessions;
}

export function teachingTimetablePagesToRecords(pages) {
  const allItems = pages.flatMap((page) => page.items);
  const timeColumns = findTimeColumns(pages[0]?.items || []);
  if (!timeColumns) return null;

  const semester = extractSemester(allItems);
  if (!semester) throw new Error('Could not find the semester in the teaching timetable PDF.');

  const rows = [];
  let currentDay = null;
  for (const page of pages) {
    const labels = page.items
      .filter((item) => item.x < 130 && /^(CCS|CCT)\s*\d$/i.test(item.text.trim()))
      .sort((a, b) => a.y - b.y);
    const dayMarkers = page.items
      .filter((item) => item.x < 85 && timetableDayNames.has(item.text.trim().toUpperCase()))
      .sort((a, b) => a.y - b.y);

    if (labels.length) {
      const firstLabelY = labels[0].y;
      const continuation = page.items.filter((item) => item.x >= 125 && item.y < firstLabelY);
      if (continuation.length && rows.length) rows.at(-1).items.push(...continuation);
    }

    for (let index = 0; index < labels.length; index++) {
      const label = labels[index];
      const nextLabel = labels[index + 1];
      const dayMarker = dayMarkers.filter((marker) => marker.y <= label.y + 0.5).at(-1);
      if (dayMarker) currentDay = timetableDayNames.get(dayMarker.text.trim().toUpperCase());
      if (!currentDay) continue;
      const [, program, year] = label.text.trim().toUpperCase().match(/^(CCS|CCT)\s*(\d)$/);
      const rowItems = page.items.filter((item) => item.x >= 125
        && item.y >= label.y - 0.5
        && (!nextLabel || item.y < nextLabel.y - 0.5));
      rows.push({
        page: page.number,
        y: label.y,
        day: currentDay,
        group: `${program} ${year}`,
        program,
        year,
        semester,
        items: rowItems
      });
    }

  }

  if (!rows.length) return null;
  const fullCourseCodes = new Set();
  const sameTimeCourseCodes = new Map();
  for (const row of rows) {
    const cellTexts = new Map();
    for (const item of row.items) {
      const index = timeColumns.reduce((closest, column, candidate) => (
        Math.abs(item.x - column.x) < Math.abs(item.x - timeColumns[closest].x) ? candidate : closest
      ), 0);
      const cell = cellTexts.get(index) || [];
      cell.push(item.text);
      cellTexts.set(index, cell);
    }
    for (const text of cellTexts.values()) {
      const parsed = courseCodeFromText(text.join(' '));
      if (parsed && !parsed.abbreviated) fullCourseCodes.add(parsed.code);
    }
    for (const [index, text] of cellTexts) {
      const parsed = courseCodeFromText(text.join(' '));
      if (!parsed || parsed.abbreviated) continue;
      const key = `${row.day}|${index}|${parsed.code.match(/\d{3}[A-Z]?$/)?.[0]}`;
      const matches = sameTimeCourseCodes.get(key) || new Set();
      matches.add(parsed.code);
      sameTimeCourseCodes.set(key, matches);
    }
  }

  const neighborCodes = new Map([...sameTimeCourseCodes].map(([key, values]) => [key, [...values]]));
  const records = rows.flatMap((row) => timetableRecordsForRow(row, timeColumns, [...fullCourseCodes], neighborCodes));
  if (!records.length) throw new Error('No scheduled courses were found in the teaching timetable PDF.');
  return records;
}

function findHeader(items, requiredColumns) {
  const columns = [];
  for (let index = 0; index < items.length; index++) {
    let match;
    for (let length = Math.min(3, items.length - index); length > 0; length--) {
      const text = items.slice(index, index + length).map((item) => item.text).join(' ');
      const column = columnAliases.get(normalizeHeader(text));
      if (column) {
        match = { column, x: items[index].x };
        index += length - 1;
        break;
      }
    }
    if (match) columns.push(match);
  }
  const names = new Set(columns.map(({ column }) => column));
  if (!requiredColumns.every((column) => names.has(column))) return null;
  return columns.sort((a, b) => a.x - b.x);
}

function rowToRecord(items, columns) {
  const cells = columns.map(() => []);
  const boundaries = columns.slice(1).map((column, index) => (columns[index].x + column.x) / 2);
  for (const item of items) {
    let columnIndex = boundaries.findIndex((boundary) => item.x < boundary);
    if (columnIndex < 0) columnIndex = columns.length - 1;
    cells[columnIndex].push(item);
  }
  return Object.fromEntries(columns.map(({ column }, index) => [
    column,
    cells[index].sort((a, b) => a.x - b.x).map(({ text }) => text).join(' ').trim()
  ]));
}

export function pdfItemsToRecords(items, requiredColumns = timetableColumns, tableLabel = 'timetable') {
  if (!items.length) throw new Error('This PDF contains no selectable text. Scanned or image-only PDFs are not supported.');

  const records = [];
  let columns = null;
  for (const line of groupLines(items)) {
    const header = findHeader(line.items, requiredColumns);
    if (header) {
      columns = header;
      continue;
    }
    if (!columns) continue;
    const record = rowToRecord(line.items, columns);
    if (Object.values(record).some(Boolean)) records.push(record);
  }
  if (!columns) throw new Error(`Could not find a PDF table with the required ${tableLabel} column headings: ${requiredColumns.join(', ')}.`);
  if (!records.length) throw new Error(`No ${tableLabel} rows were found below the PDF table headings.`);
  return records;
}

export async function extractPdfRecords(buffer, requiredColumns = timetableColumns, tableLabel = 'timetable') {
  let document;
  try {
    document = await getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useSystemFonts: true
    }).promise;
    const items = [];
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const pageItems = [];
      for (const item of content.items) {
        if ('str' in item && item.str.trim() && item.transform) {
          const textItem = {
            page: pageNumber,
            x: item.transform[4],
            y: viewport.height - item.transform[5],
            text: item.str
          };
          items.push(textItem);
          pageItems.push(textItem);
        }
      }
      pages.push({ number: pageNumber, width: viewport.width, height: viewport.height, items: pageItems });
      page.cleanup();
    }
    if (tableLabel === 'timetable') {
      const editableTeachingTimetable = editableTeachingTimetablePagesToRecords(pages);
      if (editableTeachingTimetable) return editableTeachingTimetable;
      const teachingTimetable = teachingTimetablePagesToRecords(pages);
      if (teachingTimetable) return teachingTimetable;
    }
    return pdfItemsToRecords(items, requiredColumns, tableLabel);
  } catch (error) {
    if (error instanceof Error && /selectable text|PDF table|rows were found|teaching timetable|scheduled courses/i.test(error.message)) throw error;
    throw new Error('Could not read this PDF. It may be damaged or password-protected.', { cause: error });
  } finally {
    await document?.destroy();
  }
}

export function extractPdfTimetable(buffer) {
  return extractPdfRecords(buffer, timetableColumns, 'timetable');
}

export async function extractPdfUnitOfferings(buffer) {
  let document;
  let worker;
  try {
    document = await getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useSystemFonts: true
    }).promise;
    if (document.numPages > maximumOcrPages) {
      throw new Error(`Unit-list PDFs can have at most ${maximumOcrPages} pages.`);
    }

    const nativeItems = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      for (const item of content.items) {
        if ('str' in item && item.str.trim() && item.transform) {
          nativeItems.push({
            page: pageNumber,
            pageWidth: viewport.width,
            x: item.transform[4],
            y: viewport.height - item.transform[5],
            text: item.str
          });
        }
      }
      page.cleanup();
    }

    if (nativeItems.length) {
      try {
        const records = pdfItemsToRecords(nativeItems, ['course_code', 'unit_name', 'year', 'semester'], 'units-offered');
        return records.map((record) => ({
          course_code: record.course_code,
          unit_name: record.unit_name,
          year: String(record.year),
          semester: String(record.semester)
        }));
      } catch (error) {
        if (!(error instanceof Error) || !/selectable text|PDF table|rows were found/i.test(error.message)) throw error;
      }
      try {
        return yearSectionItemsToOfferings(nativeItems);
      } catch (error) {
        if (!(error instanceof Error) || !/Could not find|No course rows/i.test(error.message)) throw error;
      }
    }

    const require = createRequire(import.meta.url);
    const languagePath = join(dirname(require.resolve('@tesseract.js-data/eng')), '4.0.0_best_int');
    const corePath = dirname(require.resolve('tesseract.js-core'));
    worker = await createWorker('eng', 1, {
      langPath: languagePath,
      corePath,
      cacheMethod: 'none',
      gzip: true
    });

    const ocrItems = [];
    const gridOfferings = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const scale = 3;
      const viewport = page.getViewport({ scale });
      const rendered = document.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        await page.render({ canvasContext: rendered.context, viewport }).promise;
        const pageImage = rendered.canvas.toBuffer('image/png');
        await worker.setParameters({ tessedit_pageseg_mode: '3', tessedit_char_whitelist: '' });
        const { data } = await worker.recognize(pageImage, {}, { blocks: true });
        addOcrWords(ocrItems, data, pageNumber, viewport.width);

        const pageBitmap = await loadImage(pageImage);
        const sourceCanvas = createCanvas(pageBitmap.width, pageBitmap.height);
        sourceCanvas.getContext('2d').drawImage(pageBitmap, 0, 0);
        const headingsCanvas = thresholdCanvas(sourceCanvas);
        const pageYearHeadings = [];
        for (const [top, bottom] of greenHeadingBands(sourceCanvas)) {
          const crop = createCanvas(sourceCanvas.width, bottom - top);
          crop.getContext('2d').drawImage(headingsCanvas, 0, top, sourceCanvas.width, bottom - top, 0, 0, sourceCanvas.width, bottom - top);
          await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '' });
          const { data: headingData } = await worker.recognize(crop.toBuffer('image/png'), {}, { blocks: true });
          addOcrWords(ocrItems, headingData, pageNumber, viewport.width, top);
          const year = yearFromText(headingData.text);
          if (year) pageYearHeadings.push({ year, y: (top + bottom) / 2 });
        }
        gridOfferings.push(...await extractGridOfferings(sourceCanvas, worker, pageNumber, pageYearHeadings));
      } finally {
        document.canvasFactory.destroy(rendered);
      }
      page.cleanup();
    }
    if (gridOfferings.length) {
      const semester = extractSemester(ocrItems);
      if (!semester) throw new Error('Could not find a semester heading such as “SEMESTER ONE” in the PDF.');
      return gridOfferings.map((offering) => ({ ...offering, semester: String(semester) }));
    }
    return yearSectionItemsToOfferings(ocrItems);
  } catch (error) {
    if (error instanceof Error && /PDF|semester|year|course|selectable text|reliably read/i.test(error.message)) throw error;
    throw new Error('Could not extract the offered units from this PDF.', { cause: error });
  } finally {
    await worker?.terminate();
    await document?.destroy();
  }
}
