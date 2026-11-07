import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

export function makeAuth(repo, secret = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex')) {
  const sign = (u) => jwt.sign({ sub: u.id, role: u.role, name: u.name }, secret, { expiresIn: '12h' });
  const verify = (t) => { try { return jwt.verify(t, secret); } catch { return null; } };
  const strip = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

  async function register({ email, name, password }) {
    if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 190) throw httpErr(400, 'valid email required');
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw httpErr(400, 'name required');
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) throw httpErr(400, 'password must be 8-72 characters');
    const passwordHash = await bcrypt.hash(password, 10);
    try { const u = await repo.createUser({ email: email.toLowerCase(), name: name.trim(), passwordHash }); return { user: strip(u), token: sign(u) }; }
    catch (e) { if (e.code === 'DUP') throw httpErr(409, 'email already registered'); throw e; }
  }
  async function login({ email, password }) {
    const u = typeof email === 'string' ? await repo.findUserByEmail(email.toLowerCase()) : null;
    if (!u || typeof password !== 'string' || !(await bcrypt.compare(password, u.passwordHash))) throw httpErr(401, 'invalid credentials');
    return { user: strip(u), token: sign(u) };
  }
  const middleware = (role) => (req, res, next) => {
    const h = req.headers.authorization || '';
    const p = h.startsWith('Bearer ') ? verify(h.slice(7)) : null;
    if (!p) return res.status(401).json({ error: 'authentication required' });
    if (role && p.role !== role) return res.status(403).json({ error: `${role} role required` });
    req.user = p; next();
  };
  return { register, login, verify, middleware };
}

export function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
