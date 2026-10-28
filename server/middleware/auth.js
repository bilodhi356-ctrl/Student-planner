import jwt from 'jsonwebtoken';

export function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Your session expired. Please sign in again.' }); }
}

export function requireAdmin(req, res, next) {
  if (!['admin','class_rep'].includes(req.user?.role)) return res.status(403).json({ error: 'Class representative access is required.' });
  next();
}

export function requireAdministrator(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
  next();
}
