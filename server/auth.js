// Authentication module for Shimi Trading App
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import crypto from 'crypto';

// JWT secret - generate a random one if not set in environment
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const JWT_EXPIRY = '7d'; // Tokens expire in 7 days

const USERS_FILE = './users.json';

// Initialize users file if it doesn't exist
function initUsersFile() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users: {} }, null, 2));
  }
}

// Load users from file
function loadUsers() {
  initUsersFile();
  try {
    const data = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error loading users:', err);
    return { users: {} };
  }
}

// Save users to file
function saveUsers(usersData) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2));
    return true;
  } catch (err) {
    console.error('Error saving users:', err);
    return false;
  }
}

// Find user by email
function findUserByEmail(email) {
  const { users } = loadUsers();
  return Object.values(users).find(u => u.email.toLowerCase() === email.toLowerCase());
}

// Find user by ID
function findUserById(userId) {
  const { users } = loadUsers();
  return users[userId] || null;
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
  if (findUserByEmail(email)) {
    throw new Error('An account with this email already exists');
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, 10);

  // Create user
  const userId = `user_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const user = {
    id: userId,
    email: email.toLowerCase(),
    passwordHash,
    createdAt: new Date().toISOString(),
    profileId: null // Will be linked when they create/select a profile
  };

  // Save user
  const usersData = loadUsers();
  usersData.users[userId] = user;
  saveUsers(usersData);

  // Generate JWT token
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

  console.log(`New user registered: ${email} (${userId})`);

  return { userId, email: user.email, token };
}

// Login user
export async function loginUser(email, password) {
  const user = findUserByEmail(email);

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

  return { userId: user.id, email: user.email, token, profileId: user.profileId };
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
export function getUserInfo(userId) {
  const user = findUserById(userId);
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    profileId: user.profileId
  };
}

// Link a profile to a user
export function linkProfileToUser(userId, profileId) {
  const usersData = loadUsers();
  if (usersData.users[userId]) {
    usersData.users[userId].profileId = profileId;
    saveUsers(usersData);
    return true;
  }
  return false;
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
export function getAllUsers() {
  const { users } = loadUsers();
  return Object.values(users).map(u => ({
    id: u.id,
    email: u.email,
    createdAt: u.createdAt,
    profileId: u.profileId
  }));
}

export default {
  registerUser,
  loginUser,
  verifyToken,
  getUserInfo,
  linkProfileToUser,
  authMiddleware,
  optionalAuthMiddleware,
  getAllUsers
};
