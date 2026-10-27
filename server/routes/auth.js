import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db/index.js';

const router = Router();
const tokenFor = (student) => jwt.sign({ sub: String(student.id), role: student.role, name: student.name, email: student.email }, process.env.JWT_SECRET, { expiresIn: '14d' });

router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '') || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Enter your name, a valid email, and a password of at least 8 characters.' });
    }
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query('INSERT INTO students(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email,role', [name.trim(), email.toLowerCase(), hash]);
    await pool.query('INSERT INTO reminder_preferences(student_id) VALUES($1)', [rows[0].id]);
    res.status(201).json({ token: tokenFor(rows[0]), user: rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'An account with this email already exists.' });
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT id,name,email,password_hash,role FROM students WHERE email=$1', [(email || '').toLowerCase()]);
    if (!rows[0] || !(await bcrypt.compare(password || '', rows[0].password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
    const { password_hash, ...user } = rows[0];
    res.json({ token: tokenFor(user), user });
  } catch (error) { next(error); }
});

export default router;
