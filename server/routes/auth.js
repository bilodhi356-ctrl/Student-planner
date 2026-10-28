import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db/index.js';

const router = Router();
const tokenFor = (student) => jwt.sign({ sub: String(student.id), role: student.role, name: student.name, email: student.email, registration_number: student.registration_number || null }, process.env.JWT_SECRET, { expiresIn: '14d' });

router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    const registrationNumber = String(req.body.registrationNumber || '').trim().toUpperCase();
    const match = registrationNumber.match(/^(CCT|CCS)\/(\d{5})\/((?:19|20)\d{2})$/);
    if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '') || !match || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Enter your name, university email, registration number (CCT/00002/YYYY or CCS/00023/YYYY), and a password of at least 8 characters.' });
    }
    const hash = await bcrypt.hash(password, 12);
    const programCode = match[1] === 'CCT' ? 'BSC-CT' : 'BSC-CS';
    const { rows } = await pool.query(`INSERT INTO students(name,email,password_hash,registration_number,program_id)
      SELECT $1,$2,$3,$4,id FROM programs WHERE code=$5
      RETURNING id,name,email,role,registration_number`, [name.trim(), email.toLowerCase(), hash, registrationNumber, programCode]);
    if (!rows[0]) return res.status(500).json({ error: 'The matching study program is not configured.' });
    await pool.query('INSERT INTO reminder_preferences(student_id) VALUES($1)', [rows[0].id]);
    res.status(201).json({ token: tokenFor(rows[0]), user: rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That email or registration number is already in use.' });
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { password } = req.body;
    const identifier = String(req.body.identifier || req.body.email || '').trim();
    const normalizedIdentifier = identifier.includes('@') ? identifier.toLowerCase() : identifier.toUpperCase();
    const { rows } = await pool.query('SELECT id,name,email,password_hash,role,registration_number FROM students WHERE LOWER(email)=$1 OR UPPER(registration_number)=$1', [normalizedIdentifier]);
    if (!rows[0] || !(await bcrypt.compare(password || '', rows[0].password_hash))) return res.status(401).json({ error: 'Email or registration number and password do not match.' });
    const { password_hash, ...user } = rows[0];
    res.json({ token: tokenFor(user), user });
  } catch (error) { next(error); }
});

export default router;
