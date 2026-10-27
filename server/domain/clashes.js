import { addDays, format, getDay, isBefore, isEqual, parseISO, set } from 'date-fns';

const dayIndex = (date) => (getDay(date) + 6) % 7;

export function makeInterval(date, startTime, endTime, id = '') {
  const [startHour, startMinute] = startTime.slice(0, 5).split(':').map(Number);
  const [endHour, endMinute] = endTime.slice(0, 5).split(':').map(Number);
  const base = typeof date === 'string' ? parseISO(date) : date;
  const start = set(base, { hours: startHour, minutes: startMinute, seconds: 0, milliseconds: 0 });
  let end = set(base, { hours: endHour, minutes: endMinute, seconds: 0, milliseconds: 0 });
  if (!isBefore(start, end)) end = addDays(end, 1);
  return { id, start, end };
}

export function intervalsOverlap(a, b) {
  return isBefore(a.start, b.end) && isBefore(b.start, a.end);
}

export function intervalsTouch(a, b) {
  return isEqual(a.end, b.start) || isEqual(b.end, a.start);
}

export function analyzeIntervals(items) {
  const clashes = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      if (a.id === b.id) continue;
      if (intervalsOverlap(a, b)) clashes.push({ type: 'overlap', a, b });
      else if (intervalsTouch(a, b) && a.venue && b.venue && a.venue !== b.venue) {
        clashes.push({ type: 'back-to-back-venue', a, b });
      }
    }
  }
  return clashes;
}

export function expandSessions(sessions, fromDate, toDate) {
  const from = typeof fromDate === 'string' ? parseISO(fromDate) : fromDate;
  const to = typeof toDate === 'string' ? parseISO(toDate) : toDate;
  const result = [];
  for (const session of sessions) {
    if (session.kind === 'exam') {
      const date = typeof session.session_date === 'string' ? session.session_date.slice(0, 10) : format(session.session_date, 'yyyy-MM-dd');
      const examDate = parseISO(date);
      if (!isBefore(examDate, from) && !isBefore(to, examDate)) result.push({ ...session, ...makeInterval(examDate, session.start_time, session.end_time, session.id), date });
      continue;
    }
    // Start one day early so an overnight lecture crossing the window is included.
    for (let date = addDays(from, -1); !isBefore(to, date); date = addDays(date, 1)) {
      if (dayIndex(date) !== Number(session.day_of_week)) continue;
      const dateKey = format(date, 'yyyy-MM-dd');
      result.push({ ...session, ...makeInterval(date, session.start_time, session.end_time, session.id), date: dateKey });
    }
  }
  return result.sort((a, b) => a.start - b.start);
}

export function detectScheduleClashes(sessions, fromDate, toDate) {
  const instances = expandSessions(sessions, fromDate, toDate);
  const clashes = analyzeIntervals(instances);
  // Two exams on one date need a review even when the sitting times do not overlap.
  const examsByDate = new Map();
  for (const exam of instances.filter((item) => item.kind === 'exam')) {
    const list = examsByDate.get(exam.date) || [];
    list.push(exam);
    examsByDate.set(exam.date, list);
  }
  for (const [date, exams] of examsByDate) {
    for (let i = 0; i < exams.length; i += 1) {
      for (let j = i + 1; j < exams.length; j += 1) {
        const a = exams[i];
        const b = exams[j];
        if (!clashes.some((clash) => clash.type === 'same-day-exams' && clash.a.id === a.id && clash.b.id === b.id)) {
          clashes.push({ type: 'same-day-exams', date, a, b });
        }
      }
    }
  }
  return clashes;
}
