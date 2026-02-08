// Authentication module for Shimi Trading App
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { pool } from './db.js';

// In production, JWT_SECRET MUST be set — random secrets invalidate all sessions on restart
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production environment');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const JWT_EXPIRY = '7d'; // Tokens expire in 7 days

if (!process.env.JWT_SECRET) {
  console.warn('JWT_SECRET not set in environment, using generated secret (will change on restart)');
}

// Find user by email
async function findUserByEmail(email) {
  const result = await pool.query(
    'SELECT user_id, email, password_hash, created_at FROM users WHERE LOWER(email) = LOWER($1)',
    [email]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.user_id,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at
  };
}

// Find user by ID
async function findUserById(userId) {
  const result = await pool.query(
    'SELECT user_id, email, password_hash, created_at FROM users WHERE user_id = $1',
    [userId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.user_id,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at
  };
}

// Register a new user
export async function registerUser(email, password) {
  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error('Invalid email format');
  }

  // Validate password strength
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters');
  }

  // Check if user already exists
  const existingUser = await findUserByEmail(email);
  if (existingUser) {
    throw new Error('An account with this email already exists');
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, 10);

  // Create user
  const userId = `user_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  await pool.query(
    'INSERT INTO users (user_id, email, password_hash) VALUES ($1, $2, $3)',
    [userId, email.toLowerCase(), passwordHash]
  );

  // Generate JWT token
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

  console.log(`New user registered: ${email} (${userId})`);

  return { userId, email: email.toLowerCase(), token };
}

// Login user
export async function loginUser(email, password) {
  const user = await findUserByEmail(email);

  if (!user) {
    throw new Error('Invalid email or password');
  }

  const isValidPassword = await bcrypt.compare(password, user.passwordHash);
  if (!isValidPassword) {
    throw new Error('Invalid email or password');
  }

  // Generate JWT token
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

  console.log(`User logged in: ${email} (${user.id})`);

  return { userId: user.id, email: user.email, token };
}

// Verify JWT token and return user ID
export function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.userId;
  } catch (err) {
    return null;
  }
}

// Get user info by ID
export async function getUserInfo(userId) {
  const user = await findUserById(userId);
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt
  };
}

// Auth middleware for Express routes
export function authMiddleware(req, res, next) {
  // Get token from Authorization header
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  const userId = verifyToken(token);
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }

  // Attach user ID to request for use in route handlers
  req.userId = userId;
  next();
}

// Optional auth middleware - doesn't require auth but attaches userId if present
export function optionalAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  if (token) {
    const userId = verifyToken(token);
    if (userId) {
      req.userId = userId;
    }
  }

  next();
}

// Get all users (admin function)
export async function getAllUsers() {
  const result = await pool.query(
    'SELECT user_id, email, created_at FROM users ORDER BY created_at DESC'
  );
  return result.rows.map(row => ({
    id: row.user_id,
    email: row.email,
    createdAt: row.created_at
  }));
}

export default {
  registerUser,
  loginUser,
  verifyToken,
  getUserInfo,
  authMiddleware,
  optionalAuthMiddleware,
  getAllUsers
};
