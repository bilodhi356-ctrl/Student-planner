import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { collections } from '../db/index.js';
import { programCodeFromRegistrationNumber } from '../domain/registration.js';

const router = Router();
const publicUser = (student) => ({
  id: student._id,
  name: student.name,
  email: student.email,
  role: student.role,
  registration_number: student.registration_number || null
});
const tokenFor = (student) => jwt.sign({
  sub: String(student.id || student._id),
  role: student.role,
  name: student.name,
  email: student.email,
  registration_number: student.registration_number || null
}, process.env.JWT_SECRET, { expiresIn: '14d' });

router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    const registrationNumber = String(req.body.registrationNumber || '').trim().toUpperCase();
    const programCode = programCodeFromRegistrationNumber(registrationNumber);
    if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '') || !programCode || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Enter your name, university email, registration number (CCT/00002/YYYY or CCS/00023/YYYY), and a password of at least 8 characters.' });
    }
    const program = await collections.programs.findOne({ code: programCode });
    if (!program) return res.status(500).json({ error: 'The matching study program is not configured.' });
    const student = {
      _id: randomUUID(),
      name: name.trim(),
      email: email.toLowerCase(),
      password_hash: await bcrypt.hash(password, 12),
      registration_number: registrationNumber,
      role: 'student',
      program_id: program._id,
      year_of_study: null,
      semester: null,
      created_at: new Date()
    };
    await collections.students.insertOne(student);
    await collections.reminderPreferences.insertOne({
      student_id: student._id,
      exam_hours_before: 24,
      class_minutes_before: 60,
      enabled: true
    });
    const user = publicUser(student);
    res.status(201).json({ token: tokenFor(user), user });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'That email or registration number is already in use.' });
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { password } = req.body;
    const identifier = String(req.body.identifier || req.body.email || '').trim();
    const normalizedIdentifier = identifier.includes('@') ? identifier.toLowerCase() : identifier.toUpperCase();
    const student = await collections.students.findOne({
      $or: [{ email: normalizedIdentifier.toLowerCase() }, { registration_number: normalizedIdentifier }]
    });
    if (!student || !(await bcrypt.compare(password || '', student.password_hash))) {
      return res.status(401).json({ error: 'Email or registration number and password do not match.' });
    }
    const user = publicUser(student);
    res.json({ token: tokenFor(user), user });
  } catch (error) { next(error); }
});

export default router;
