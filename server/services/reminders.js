import cron from 'node-cron';
import nodemailer from 'nodemailer';
import { addDays, addMinutes, format, isAfter, isBefore } from 'date-fns';
import { pool } from '../db/index.js';
import { expandSessions } from '../domain/clashes.js';

const configured = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD;
const mailer = configured ? nodemailer.createTransport({ host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT || 587),secure:Number(process.env.SMTP_PORT)===465,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD} }) : null;

export function startReminderJob() {
  if (!mailer) { console.log('Email reminders are disabled until SMTP settings are configured.'); return; }
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { rows: students } = await pool.query(`SELECT st.id,st.email,st.name,p.exam_hours_before,p.class_minutes_before
        FROM students st JOIN reminder_preferences p ON p.student_id=st.id WHERE p.enabled=TRUE`);
      const now = new Date();
      for (const student of students) {
        const { rows: sessions } = await pool.query(`SELECT s.id,s.unit_id,u.code,u.name,s.kind,s.group_name,s.day_of_week,
          s.session_date::text,s.start_time::text,s.end_time::text,v.name venue,sel.selected_group
          FROM selections sel JOIN sessions s ON s.unit_id=sel.unit_id JOIN units u ON u.id=s.unit_id
          LEFT JOIN venues v ON v.id=s.venue_id WHERE sel.student_id=$1 AND (sel.selected_group IS NULL OR sel.selected_group=s.group_name)`,[student.id]);
        const instances=expandSessions(sessions,format(now,'yyyy-MM-dd'),format(addDays(now,15),'yyyy-MM-dd'));
        const firstClasses=new Map();
        for(const item of instances.filter((session)=>session.kind==='lecture')) if(!firstClasses.has(item.unit_id)) firstClasses.set(item.unit_id,item);
        const candidates=[...instances.filter((session)=>session.kind==='exam').map((item)=>({...item,reminder_kind:'exam',threshold:student.exam_hours_before*60})),
          ...firstClasses.values()].map((item)=>item.reminder_kind?item:{...item,reminder_kind:'first-class',threshold:student.class_minutes_before});
        for(const item of candidates){
          const start=item.start;
          const reminderAt=addMinutes(start,-item.threshold);
          if(isBefore(reminderAt,addMinutes(now,-5))||isAfter(reminderAt,addMinutes(now,5))) continue;
          const exists=await pool.query('SELECT 1 FROM reminder_deliveries WHERE student_id=$1 AND session_id=$2 AND occurrence_start=$3 AND reminder_kind=$4',[student.id,item.id,start,item.reminder_kind]);
          if(exists.rowCount) continue;
          const label=item.reminder_kind==='exam'?'Exam':'First class';
          await mailer.sendMail({from:process.env.SMTP_FROM || process.env.SMTP_USER,to:student.email,subject:`${label} reminder: ${item.code}`,
            text:`Hi ${student.name},\n\nYour ${label.toLowerCase()} for ${item.code} — ${item.name} starts at ${format(start,'PPpp')}${item.venue?` in ${item.venue}`:''}.\n\nStudent Planner`});
          await pool.query(`INSERT INTO reminder_deliveries(student_id,session_id,occurrence_start,reminder_kind)
            VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[student.id,item.id,start,item.reminder_kind]);
        }
      }
    } catch(error){console.error('Reminder job failed:',error.message);}
  },{timezone:process.env.APP_TIME_ZONE || 'UTC'});
}
