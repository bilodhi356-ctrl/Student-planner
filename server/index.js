import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authRouter from './routes/auth.js';
import { plannerRouter } from './routes/planner.js';
import { pool } from './db/index.js';
import { startReminderJob } from './services/reminders.js';

const app=express();
app.use(cors({origin:process.env.CLIENT_ORIGIN || 'http://localhost:5173'}));
app.use(express.json({limit:'1mb'}));
app.get('/api/health',(_req,res)=>res.json({ok:true}));
app.use('/api/auth',authRouter);
app.use('/api',plannerRouter);
app.use((error,_req,res,_next)=>{console.error(error);res.status(500).json({error:'Something went wrong. Please try again.'})});

async function ensureAdmin(){
  const email=process.env.ADMIN_EMAIL;
  const password=process.env.ADMIN_PASSWORD;
  if(!email||!password)return;
  const hash=await bcrypt.hash(password,12);
  await pool.query(`INSERT INTO students(name,email,password_hash,role) VALUES('Timetable administrator',$1,$2,'admin')
    ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,role='admin'`,[email.toLowerCase(),hash]);
}

const currentDir=path.dirname(fileURLToPath(import.meta.url));
if(process.env.NODE_ENV==='production'){
  const clientDist=path.resolve(currentDir,'../client/dist');
  app.use(express.static(clientDist));
  app.get('*',(req,res)=>res.sendFile(path.join(clientDist,'index.html')));
}

const port=Number(process.env.PORT || 4000);
try{
  await pool.query('SELECT 1');
  await ensureAdmin();
  startReminderJob();
  app.listen(port,()=>console.log(`Student Planner API listening on http://localhost:${port}`));
}catch(error){
  console.error('Could not connect to PostgreSQL. Check DATABASE_URL and run npm run db:migrate.',error);
  process.exit(1);
}
