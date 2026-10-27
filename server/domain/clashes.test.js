import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeIntervals, detectScheduleClashes, makeInterval } from './clashes.js';

const interval = (id, date, start, end, venue = 'Hall A') => ({ ...makeInterval(date, start, end, id), id, venue });

test('adjacent half-open intervals do not overlap', () => {
  const a = interval('a', '2026-10-26', '09:00', '10:00');
  const b = interval('b', '2026-10-26', '10:00', '11:00');
  assert.deepEqual(analyzeIntervals([a, b]), []);
});

test('overlapping intervals are flagged', () => {
  const a = interval('a', '2026-10-26', '09:00', '10:15');
  const b = interval('b', '2026-10-26', '10:00', '11:00');
  assert.equal(analyzeIntervals([a, b])[0].type, 'overlap');
});

test('back-to-back sessions in different venues are flagged for travel', () => {
  const a = interval('a', '2026-10-26', '09:00', '10:00', 'Science Block');
  const b = interval('b', '2026-10-26', '10:00', '11:00', 'Library');
  assert.equal(analyzeIntervals([a, b])[0].type, 'back-to-back-venue');
});

test('sessions spanning midnight overlap the next day correctly', () => {
  const a = interval('a', '2026-10-26', '23:30', '00:30');
  const b = interval('b', '2026-10-27', '00:15', '01:00');
  assert.equal(a.end - a.start, 60 * 60 * 1000);
  assert.equal(analyzeIntervals([a, b])[0].type, 'overlap');
});

test('sessions ending exactly when another starts across midnight are adjacent', () => {
  const a = interval('a', '2026-10-26', '23:00', '00:00');
  const b = interval('b', '2026-10-27', '00:00', '01:00', 'Library');
  assert.equal(analyzeIntervals([a, b])[0].type, 'back-to-back-venue');
});

test('two non-overlapping exams on the same date still need a review', () => {
  const sessions=[
    {id:'exam-a',unit_id:1,kind:'exam',session_date:'2026-10-26',start_time:'09:00',end_time:'10:00'},
    {id:'exam-b',unit_id:2,kind:'exam',session_date:'2026-10-26',start_time:'14:00',end_time:'15:00'}
  ];
  assert.ok(detectScheduleClashes(sessions,'2026-10-26','2026-10-26').some(clash=>clash.type==='same-day-exams'));
});

test('a recurring lecture overlaps an exam on the same weekday', () => {
  const sessions=[
    {id:'lecture',unit_id:1,kind:'lecture',day_of_week:0,start_time:'09:00',end_time:'10:30'},
    {id:'exam',unit_id:2,kind:'exam',session_date:'2026-10-26',start_time:'10:00',end_time:'12:00'}
  ];
  assert.ok(detectScheduleClashes(sessions,'2026-10-26','2026-10-26').some(clash=>clash.type==='overlap'));
});
