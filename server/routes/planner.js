import { Router } from 'express';
import express from 'express';
import { createEvents } from 'ics';
import { parseTimetable, importTimetable } from '../services/importTimetable.js';
import { detectScheduleClashes } from '../domain/clashes.js';
import { pool } from '../db/index.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/programs', async (_req,res,next)=>{
  try{const {rows}=await pool.query('SELECT id,code,name FROM programs ORDER BY name');res.json(rows)}catch(error){next(error)}
});

router.get('/academic-profile', async(req,res,next)=>{
  try{const {rows}=await pool.query('SELECT program_id,year_of_study,semester FROM students WHERE id=$1',[req.user.sub]);res.json(rows[0]||{})}catch(error){next(error)}
});

router.get('/units', async (req, res, next) => {
  try {
    const { year, semester, program } = req.query;
    const { rows } = await pool.query(`SELECT u.id,u.code,u.name,u.year,u.semester,
      COALESCE(json_agg(DISTINCT s.group_name) FILTER (WHERE s.id IS NOT NULL),'[]') groups
      FROM units u LEFT JOIN sessions s ON s.unit_id=u.id WHERE u.active=TRUE
      AND ($1::int IS NULL OR u.year=$1) AND ($2::int IS NULL OR u.semester=$2) AND ($3::bigint IS NULL OR u.program_id=$3)
      GROUP BY u.id ORDER BY u.code`, [year ? Number(year) : null, semester ? Number(semester) : null,program?Number(program):null]);
    res.json(rows);
  } catch (error) { next(error); }
});

router.get('/selections', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT s.unit_id unit_id,u.code,u.name,u.year,u.semester,s.selected_group
      FROM selections s JOIN units u ON u.id=s.unit_id WHERE s.student_id=$1 ORDER BY u.code`, [req.user.sub]);
    res.json(rows);
  } catch (error) { next(error); }
});

router.put('/selections', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const choices = Array.isArray(req.body.units) ? req.body.units : [];
    await client.query('BEGIN');
    const academic=req.body.academic||{};
    await client.query(`UPDATE students SET program_id=$2,year_of_study=$3,semester=$4 WHERE id=$1`,[
      req.user.sub,academic.program_id||null,academic.year?Number(academic.year):null,academic.semester?Number(academic.semester):null]);
    await client.query('DELETE FROM selections WHERE student_id=$1', [req.user.sub]);
    for (const choice of choices) await client.query(`INSERT INTO selections(student_id,unit_id,selected_group)
      SELECT $1,id,$3 FROM units WHERE id=$2 ON CONFLICT(student_id,unit_id) DO UPDATE SET selected_group=EXCLUDED.selected_group`, [req.user.sub,choice.id,choice.group || null]);
    await client.query('COMMIT');
    res.json({ saved: choices.length });
  } catch (error) { await client.query('ROLLBACK'); next(error); }
  finally { client.release(); }
});

async function getSelectedSessions(studentId, { from, to, kind } = {}) {
  const { rows } = await pool.query(`SELECT s.id,s.unit_id,u.code,u.name,u.year,u.semester,s.kind,s.group_name,
      s.day_of_week,s.session_date::text,s.start_time::text,s.end_time::text,v.name venue,v.building,
      sel.selected_group
    FROM selections sel JOIN sessions s ON s.unit_id=sel.unit_id JOIN units u ON u.id=s.unit_id
    LEFT JOIN venues v ON v.id=s.venue_id
    WHERE sel.student_id=$1 AND (sel.selected_group IS NULL OR sel.selected_group=s.group_name)
    AND ($2::text IS NULL OR s.kind=$2)
    AND (s.kind='lecture' OR ($3::date IS NULL OR s.session_date >= $3) AND ($4::date IS NULL OR s.session_date <= $4))
    ORDER BY s.day_of_week,s.start_time,s.session_date`, [studentId,kind || null,from || null,to || null]);
  return rows;
}

router.get('/timetable', async (req, res, next) => {
  try {
    const from = req.query.from;
    const to = req.query.to;
    if (!from || !to) return res.status(400).json({ error: 'Provide from and to dates (YYYY-MM-DD).' });
    const sessions = await getSelectedSessions(req.user.sub,{ from,to });
    const groups = await pool.query(`SELECT DISTINCT s.unit_id,u.code,s.group_name FROM sessions s JOIN units u ON u.id=s.unit_id
      JOIN selections sel ON sel.unit_id=s.unit_id WHERE sel.student_id=$1 ORDER BY s.unit_id,s.group_name`,[req.user.sub]);
    const clashes = detectScheduleClashes(sessions,from,to);
    const selectedUnits=[...new Set(sessions.map(session=>String(session.unit_id)))];
    const suggestions=[];
    for(const unitId of selectedUnits){
      const availableGroups=groups.rows.filter(row=>String(row.unit_id)===unitId).map(row=>row.group_name);
      const currentGroups=new Set(sessions.filter(session=>String(session.unit_id)===unitId).map(session=>session.group_name));
      for(const groupName of availableGroups){
        if(currentGroups.size===1&&currentGroups.has(groupName))continue;
        const {rows:candidates}=await pool.query(`SELECT s.id,s.unit_id,u.code,u.name,s.kind,s.group_name,s.day_of_week,
          s.session_date::text,s.start_time::text,s.end_time::text,v.name venue
          FROM sessions s JOIN units u ON u.id=s.unit_id LEFT JOIN venues v ON v.id=s.venue_id
          WHERE s.unit_id=$1 AND s.group_name=$2`,[unitId,groupName]);
        const alternativeClashes=detectScheduleClashes([...sessions.filter(session=>String(session.unit_id)!==unitId),...candidates],from,to);
        const blocked=alternativeClashes.some(clash=>String(clash.a.unit_id)===unitId||String(clash.b.unit_id)===unitId);
        if(!blocked)suggestions.push({unit_id:unitId,group_name:groupName});
      }
    }
    res.json({ sessions, clashes, groups: groups.rows, suggestions });
  } catch (error) { next(error); }
});

router.get('/changes', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT c.id,c.unit_code,c.change_type,c.before_data,c.after_data,c.recorded_at
      FROM timetable_changes c JOIN selections s ON s.student_id=$1
      JOIN units u ON u.id=s.unit_id AND u.code=c.unit_code
      WHERE c.recorded_at > COALESCE($2::timestamptz,'1970-01-01') ORDER BY c.recorded_at DESC LIMIT 100`, [req.user.sub,req.query.since || null]);
    res.json(rows);
  } catch (error) { next(error); }
});

router.get('/calendar.ics', async (req, res, next) => {
  try {
    const from = new Date().toISOString().slice(0,10);
    const to = new Date(Date.now()+180*24*60*60*1000).toISOString().slice(0,10);
    const sessions = await getSelectedSessions(req.user.sub,{from,to});
    const clashes = detectScheduleClashes(sessions,from,to);
    const { expandSessions } = await import('../domain/clashes.js');
    const events=expandSessions(sessions,from,to).map((session)=>{
      const start=session.start;
      const minutes=Math.round((session.end-session.start)/60000);
      return {uid:`classday-${session.id}-${start.getTime()}@classday`,title:`${session.code}: ${session.name}${session.kind==='exam'?' (Exam)':''}`,
        start:[start.getFullYear(),start.getMonth()+1,start.getDate(),start.getHours(),start.getMinutes()],
        duration:{minutes},startInputType:'local',startOutputType:'local',location:session.venue || '',description:`${session.kind==='exam'?'Exam':'Lecture'} · Group ${session.group_name}`};
    });
    createEvents(events,(error,value)=>{
      if(error)return next(error);
      res.setHeader('Content-Type','text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition','attachment; filename="student-planner-schedule.ics"');
      res.send(value);
    });
  } catch(error){next(error);}
});

router.post('/admin/import', requireAdmin, express.raw({ type: () => true, limit: '12mb' }), async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Choose a timetable file to upload.' });
    const filename = decodeURIComponent(req.headers['x-file-name'] || 'timetable.csv');
    const rows = parseTimetable(req.body,filename);
    const result = await importTimetable(rows,filename,req.user.sub);
    res.json(result);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.get('/reminders', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT exam_hours_before,class_minutes_before,enabled FROM reminder_preferences WHERE student_id=$1',[req.user.sub]);
    res.json(rows[0] || { exam_hours_before:24,class_minutes_before:60,enabled:true });
  } catch (error) { next(error); }
});

router.put('/reminders', async (req, res, next) => {
  try {
    const examHours = Math.max(1,Math.min(168,Number(req.body.exam_hours_before) || 24));
    const classMinutes = Math.max(5,Math.min(1440,Number(req.body.class_minutes_before) || 60));
    const enabled = Boolean(req.body.enabled);
    const { rows } = await pool.query(`INSERT INTO reminder_preferences(student_id,exam_hours_before,class_minutes_before,enabled)
      VALUES($1,$2,$3,$4) ON CONFLICT(student_id) DO UPDATE SET exam_hours_before=EXCLUDED.exam_hours_before,
      class_minutes_before=EXCLUDED.class_minutes_before,enabled=EXCLUDED.enabled RETURNING exam_hours_before,class_minutes_before,enabled`,[req.user.sub,examHours,classMinutes,enabled]);
    res.json(rows[0]);
  } catch (error) { next(error); }
});

export { router as plannerRouter, getSelectedSessions };
