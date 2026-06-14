const express = require('express');
const router = express.Router();
const pool = require('../../db');
const auth = require('../../middleware/auth');
const { body, validationResult } = require('express-validator');

// 1. GET ALL gaming codes with stock calculated from inventory
router.get('/', async (req, res) => {
  try {
    // Cache for 5 minutes - gaming codes list
    res.set('Cache-Control', 'public, max-age=300');

    const { platform, region, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT
        gc.id,
        gc.name,
        gc.price,
        gc.region,
        gc.platform,
        gc.description,
        gc.created_at,
        COUNT(CASE WHEN gci.status = 'available' THEN 1 END) as stock
      FROM gaming_codes gc
      LEFT JOIN gaming_code_inventory gci ON gc.id = gci.gaming_code_id
      WHERE 1=1
    `;
    const params = [];
    const groupBy = ' GROUP BY gc.id, gc.name, gc.price, gc.region, gc.platform, gc.description, gc.created_at';

    // Add filters if provided
    if (platform) {
      query += ' AND gc.platform = ?';
      params.push(platform);
    }

    if (region) {
      query += ' AND gc.region = ?';
      params.push(region);
    }

    query += groupBy;

    // Add pagination
    query += ' ORDER BY gc.name LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching gaming codes:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// 5. GET SINGLE gaming code by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: 'Invalid gaming code ID' });
    }

    const [rows] = await pool.query(`
      SELECT
        gc.id,
        gc.name,
        gc.price,
        gc.region,
        gc.platform,
        gc.description,
        gc.created_at,
        COUNT(CASE WHEN gci.status = 'available' THEN 1 END) as stock
      FROM gaming_codes gc
      LEFT JOIN gaming_code_inventory gci ON gc.id = gci.gaming_code_id
      WHERE gc.id = ?
      GROUP BY gc.id, gc.name, gc.price, gc.region, gc.platform, gc.description, gc.created_at
    `, [id]);

    if (!rows.length) {
      return res.status(404).json({ message: 'Gaming code not found' });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching gaming code:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// 6. UPDATE gaming code (Manager only)
router.post(
  '/',
  auth,
  [
    body('name').trim().isLength({ min: 1, max: 200 }).withMessage('Name is required (1-200 chars)'),
    body('price').isFloat({ gt: 0, max: 999999.99 }).withMessage('Price must be positive and less than 1M'),
    body('region').optional().trim().isLength({ max: 50 }).withMessage('Region max 50 chars'),
    body('platform').optional().trim().isLength({ max: 50 }).withMessage('Platform max 50 chars'),
    body('description').optional().trim().isLength({ max: 1000 }).withMessage('Description max 1000 chars')
  ],
  async (req, res) => {
    // Only Managers allowed
    if (!req.user || req.user.role !== 'manager') {
      return res.status(403).json({ message: 'Only managers can create gaming codes' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, price, region, platform, description } = req.body;

    try {
      const [result] = await pool.query(
        'INSERT INTO gaming_codes (name, price, region, platform, description) VALUES (?, ?, ?, ?, ?)',
        [name, parseFloat(price), region || 'Global', platform || 'Mobile', description || null]
      );

      // Return the created record with calculated stock (0 initially)
      const [newRecord] = await pool.query(
        'SELECT id, name, price, region, platform, description, created_at FROM gaming_codes WHERE id = ?',
        [result.insertId]
      );

      // Add stock field (initially 0)
      newRecord[0].stock = 0;

      res.status(201).json(newRecord[0]);
    } catch (error) {
      console.error('Error creating gaming code:', error);
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: 'Gaming code with this name already exists' });
      }
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// 6. UPDATE gaming code (Manager only)
router.put(
  '/:id',
  auth,
  [
    body('name').optional().trim().isLength({ min: 1, max: 200 }).withMessage('Name must be 1-200 chars'),
    body('price').optional().isFloat({ gt: 0, max: 999999.99 }).withMessage('Price must be positive and less than 1M'),
    body('region').optional().trim().isLength({ max: 50 }).withMessage('Region max 50 chars'),
    body('platform').optional().trim().isLength({ max: 50 }).withMessage('Platform max 50 chars'),
    body('description').optional().trim().isLength({ max: 1000 }).withMessage('Description max 1000 chars')
  ],
  async (req, res) => {
    if (!req.user || req.user.role !== 'manager') {
      return res.status(403).json({ message: 'Only managers can update gaming codes' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const updates = req.body;
    const fields = [];
    const values = [];

    // Schema-compliant allowed fields
    const allowedFields = ['name', 'price', 'region', 'platform', 'description'];

    allowedFields.forEach(field => {
      if (updates.hasOwnProperty(field)) {
        fields.push(`${field} = ?`);
        values.push(field === 'price' ? parseFloat(updates[field]) : updates[field]);
      }
    });

    if (!fields.length) {
      return res.status(400).json({ message: 'No valid fields provided for update' });
    }

    values.push(id);

    try {
      const [result] = await pool.query(
        `UPDATE gaming_codes SET ${fields.join(', ')} WHERE id = ?`,
        values
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Gaming code not found' });
      }

      // Return updated record
      const [rows] = await pool.query(
        'SELECT id, name, price, region, platform, description, created_at FROM gaming_codes WHERE id = ?',
        [id]
      );
      res.json(rows[0]);
    } catch (error) {
      console.error('Error updating gaming code:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// 7. DELETE gaming code (Manager only)
router.delete('/:id', auth, async (req, res) => {
  if (!req.user || req.user.role !== 'manager') {
    return res.status(403).json({ message: 'Only managers can delete gaming codes' });
  }

  const { id } = req.params;

  // Validate ID is a number
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ message: 'Invalid gaming code ID' });
  }

  try {
    const [result] = await pool.query('DELETE FROM gaming_codes WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Gaming code not found' });
    }
    res.json({ message: 'Gaming code deleted successfully' });
  } catch (error) {
    console.error('Error deleting gaming code:', error);
    // Handle foreign key constraint errors
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ message: 'Cannot delete gaming code that has been purchased' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// 8. ADD CODES TO INVENTORY (Manager only)
router.post('/:id/inventory', auth, [
  body('codes').isArray({ min: 1 }).withMessage('At least one code required'),
  body('codes.*').isLength({ min: 1, max: 255 }).withMessage('Each code must be 1-255 characters')
], async (req, res) => {
  if (!req.user || req.user.role !== 'manager') {
    return res.status(403).json({ message: 'Only managers can manage inventory' });
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { id } = req.params;
  const { codes } = req.body;

  // Validate gaming code exists
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ message: 'Invalid gaming code ID' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Check if gaming code exists
    const [gamingCode] = await connection.query('SELECT id FROM gaming_codes WHERE id = ?', [id]);
    if (!gamingCode.length) {
      await connection.rollback();
      return res.status(404).json({ message: 'Gaming code not found' });
    }

    // Insert codes into inventory
    const values = codes.map(code => [id, code]);
    const placeholders = codes.map(() => '(?, ?)').join(', ');

    await connection.query(
      `INSERT INTO gaming_code_inventory (gaming_code_id, code) VALUES ${placeholders}`,
      values.flat()
    );

    await connection.commit();

    // Get updated stock count
    const [stockResult] = await connection.query(
      'SELECT COUNT(*) as stock FROM gaming_code_inventory WHERE gaming_code_id = ? AND status = "available"',
      [id]
    );

    res.status(201).json({
      message: `${codes.length} codes added to inventory`,
      added: codes.length,
      currentStock: stockResult[0].stock
    });

  } catch (error) {
    await connection.rollback();
    console.error('Error adding codes to inventory:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'One or more codes already exist in inventory' });
    }
    res.status(500).json({ message: 'Server error' });
  } finally {
    connection.release();
  }
});

// 9. GET INVENTORY FOR GAMING CODE (Manager only)
router.get('/:id/inventory', auth, async (req, res) => {
  if (!req.user || req.user.role !== 'manager') {
    return res.status(403).json({ message: 'Only managers can view inventory' });
  }

  const { id } = req.params;
  const { status } = req.query; // optional filter

  if (isNaN(id) || id <= 0) {
    return res.status(400).json({ message: 'Invalid gaming code ID' });
  }

  try {
    let query = `
      SELECT 
        gci.id,
        gci.code,
        gci.status,
        gci.created_at,
        gci.sold_at,
        CONCAT(b.name, ' (', b.email, ')') AS buyer_name
      FROM gaming_code_inventory gci
      LEFT JOIN buyers b ON gci.buyer_id = b.id
      WHERE gci.gaming_code_id = ?
    `;
    const params = [id];

    if (status) {
      query += ' AND gci.status = ?';
      params.push(status);
    }

    query += ' ORDER BY gci.created_at DESC';

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;