const express = require('express');
const router = express.Router();
const pool = require('../db');
const auth = require('../middleware/auth');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

// Rate limiting for auth endpoints (5 attempts per 15 minutes per IP)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  message: 'Too many authentication attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// 1. UNIFIED LOGIN (Managers & Buyers)
router.post(
  '/login',
  authLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
      // Search Managers first
      let [rows] = await pool.query('SELECT id, email, password_hash, name FROM managers WHERE email = ?', [email]);
      let role = 'manager';

      // If not found, search Buyers
      if (rows.length === 0) {
        [rows] = await pool.query('SELECT id, email, password_hash, name FROM buyers WHERE email = ?', [email]);
        role = 'buyer';
      }

      if (rows.length === 0) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      const user = rows[0];
      const validPassword = await bcrypt.compare(password, user.password_hash);
      
      if (!validPassword) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      const token = jwt.sign(
        { id: user.id, email: user.email, name: user.name, role: role },
        process.env.JWT_SECRET,
        { expiresIn: '8h' }
      );

      res.json({ 
        token, 
        user: { id: user.id, email: user.email, name: user.name, role: role } 
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// 2. MANAGER REGISTRATION (Requires Auth - only existing managers can create others)
router.post(
  '/register',
  [
    body('name').notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, password } = req.body;

    // Check for required domain
    if (!email.endsWith('@gadgetfinds.com')) {
      return res.status(403).json({ message: 'Access denied: Only @gadgetfinds.com emails can register as managers' });
    }

    try {
      const [existing] = await pool.query('SELECT id FROM managers WHERE email = ?', [email]);
      if (existing.length) {
        return res.status(409).json({ message: 'Manager with this email already exists' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const [result] = await pool.query(
        'INSERT INTO managers (name, email, password_hash) VALUES (?, ?, ?)',
        [name, email, passwordHash]
      );

      res.status(201).json({ 
        message: 'Manager created successfully',
        manager: { id: result.insertId, name, email, role: 'manager' } 
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// 3. BUYER REGISTRATION (Public - No Auth required)
router.post(
  '/buyer/register',
  [
    body('name').notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, password } = req.body;

    try {
      const [existing] = await pool.query('SELECT id FROM buyers WHERE email = ?', [email]);
      if (existing.length) {
        return res.status(409).json({ message: 'Buyer with this email already exists' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const [result] = await pool.query(
        'INSERT INTO buyers (name, email, password_hash) VALUES (?, ?, ?)',
        [name, email, passwordHash]
      );

      const token = jwt.sign(
        { id: result.insertId, email, name, role: 'buyer' },
        process.env.JWT_SECRET,
        { expiresIn: '8h' }
      );

      res.status(201).json({ 
        token, 
        buyer: { id: result.insertId, name, email, role: 'buyer' } 
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

module.exports = router;
