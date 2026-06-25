const express = require('express');
const router = express.Router();
const pool = require('../../db');
const auth = require('../../middleware/auth');
const multer = require('multer');
const path = require('path');
const rateLimit = require('express-rate-limit');

// Rate limiting for public product endpoints (100 requests per 15 minutes per IP)
const productLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: 'Too many requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// --- MULTER CONFIGURATION ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // Ensure this folder exists in your root directory
  },
  filename: (req, file, cb) => {
    // Creates a unique filename: timestamp-originalname
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// 1. GROUPED CATEGORY ROUTE (Optimized for instantaneous mobile rendering)
router.get('/', productLimiter, async (req, res) => {
  try {
    const limit = 80; // High safe threshold since indexation handles structure calculations

    res.set('Cache-Control', 'public, max-age=600, s-maxage=1200, stale-while-revalidate=60');
    
    // SQL ORDER ENGINE:
    const [rows] = await pool.query(
      `SELECT id, name, brand, category, price, old_price, stock, image_url, is_hero, features, specs 
       FROM products 
       ORDER BY 
         CASE 
           WHEN UPPER(category) = 'CONSOLE' THEN 1
           WHEN UPPER(category) = 'ACCESSORIES' THEN 2
           WHEN UPPER(category) = 'PHONES' THEN 3
           WHEN UPPER(category) = 'TVS' THEN 4
           WHEN UPPER(category) = 'DIGITAL' THEN 5
           WHEN UPPER(category) = 'PRE-OWNED' THEN 6
           WHEN UPPER(category) = 'VR GEAR' THEN 7
           WHEN UPPER(category) = 'MERCH' THEN 8
           ELSE 9
         END ASC,
         CASE WHEN id = 1 THEN 0 ELSE 1 END ASC,
         id ASC
       LIMIT ?`,
      [limit]
    );

    // Group items natively directly on database execution response threads
    const groupedProducts = rows.reduce((acc, p) => {
      const category = p.category || "Uncategorized";
      if (!acc[category]) acc[category] = [];
      
      acc[category].push({
        ...p,
        is_hero: p.is_hero === 1 || p.is_hero === true || p.is_hero === '1',
        features: p.features ? (typeof p.features === 'string' ? JSON.parse(p.features) : p.features) : [],
        specs: p.specs ? (typeof p.specs === 'string' ? JSON.parse(p.specs) : p.specs) : {}
      });
      return acc;
    }, {});

    res.json({
      catalog: Object.entries(groupedProducts)
    });
  } catch (error) {
    console.error("Grouped Catalog Query Error:", error);
    res.status(500).json({ message: 'Server data mapping layout synchronization error' });
  }
});


// NEW DEDICATED HERO ROUTE - Fast and lightweight
router.get('/hero-offers', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=1800'); // Cache for 30 minutes since hero items rarely change
    const [rows] = await pool.query(
      `SELECT id, name, price, old_price, image_url, is_hero 
       FROM products 
       WHERE is_hero = 1 
       ORDER BY id DESC`
    );
    res.json({ products: rows });
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching hero banners' });
  }
});

// 2. GET SINGLE PRODUCT
router.get('/:id', productLimiter, async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=3600');
    const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
    
    if (!rows.length) return res.status(404).json({ message: 'Product not found' });
    
    const p = rows[0];
    const product = {
      ...p,
      is_hero: !!p.is_hero,
      // Safe fallback checks ensure empty structures don't break string parsing routines
      features: typeof p.features === 'string' ? JSON.parse(p.features || '[]') : (p.features || []),
      specs: typeof p.specs === 'string' ? JSON.parse(p.specs || '{}') : (p.specs || {})
    };
    
    // BACKEND SYNC FIX: Explicitly bundle the item inside a 'product' key payload 
    // to match what your Next.js administration panel looks for.
    res.json({ product });
  } catch (error) {
    console.error("Fetch Error:", error);
    res.status(500).json({ message: 'Server error' });
  }
});

// 3. POST NEW PRODUCT
router.post('/', auth, upload.single('image'), async (req, res) => {
  if (req.user?.role !== 'manager') return res.status(403).json({ message: 'Managers only' });

  const { 
    name, brand, category, price, old_price, stock, 
    description, features, specs, is_hero 
  } = req.body;

  const image_url = req.file ? `/uploads/${req.file.filename}` : req.body.image_url;

  const parseJsonField = (field, isArray = true) => {
    if (!field) return JSON.stringify(isArray ? [] : {});
    if (typeof field === 'object') return JSON.stringify(field);
    try { return JSON.stringify(JSON.parse(field)); } 
    catch { return JSON.stringify(isArray ? [] : {}); }
  };

  try {
    const [result] = await pool.query(
      `INSERT INTO products 
      (name, brand, category, price, old_price, stock, image_url, description, features, specs, is_hero) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name, brand, category, price, old_price || null, stock || 0, image_url, description, 
        parseJsonField(features, true), 
        parseJsonField(specs, false),
        is_hero === 'true' || is_hero === true || is_hero == 1 ? 1 : 0
      ]
    );

    res.status(201).json({ id: result.insertId, ...req.body, image_url, is_hero: !!is_hero });
  } catch (error) {
    res.status(500).json({ message: 'Database error', detail: error.message });
  }
});

// 4. PUT UPDATE PRODUCT (Including is_hero)
router.put('/:id', auth, upload.single('image'), async (req, res) => {
  if (req.user?.role !== 'manager') return res.status(403).json({ message: 'Managers only' });
  const { id } = req.params;
  const { name, brand, category, price, old_price, stock, description, features, specs, is_hero } = req.body;

  let image_url = req.body.image_url;
  if (req.file) {
    image_url = `/uploads/${req.file.filename}`;
  } else if (image_url && image_url.includes('http')) {
    // Basic logic to keep relative paths
    const urlParts = image_url.split('/uploads/');
    if (urlParts.length > 1) image_url = `/uploads/${urlParts[1]}`;
  }

  const parseJsonField = (field, isArray = true) => {
    if (!field) return JSON.stringify(isArray ? [] : {});
    if (typeof field === 'object') return JSON.stringify(field);
    try { return JSON.stringify(JSON.parse(field)); } 
    catch { return JSON.stringify(isArray ? [] : {}); }
  };

  try {
    const query = `
      UPDATE products 
      SET name = ?, brand = ?, category = ?, price = ?, old_price = ?, 
          stock = ?, description = ?, features = ?, specs = ?, image_url = ?, is_hero = ?
      WHERE id = ?
    `;
    
    const values = [
      name, brand || null, category, parseFloat(price), 
      old_price ? parseFloat(old_price) : null,
      parseInt(stock) || 0, description || '',
      parseJsonField(features, true), parseJsonField(specs, false),
      image_url,
      is_hero === 'true' || is_hero === true || is_hero == 1 ? 1 : 0,
      id
    ];

    const [result] = await pool.query(query, values);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Product not found' });

    res.json({ message: 'Product updated successfully', is_hero: !!is_hero });
  } catch (error) {
    res.status(500).json({ message: 'Update failed', detail: error.message });
  }
});

// 5. BULK UPLOAD (Updated)
router.post('/bulk', auth, async (req, res) => {
  const products = req.body;
  if (!Array.isArray(products)) return res.status(400).json({ message: "Expected an array" });

  try {
    const values = products.map(p => [
      p.name, p.brand, p.category, p.price, p.old_price || null, p.stock || 0, 
      p.image_url, p.description, 
      JSON.stringify(p.features || []), 
      JSON.stringify(p.specs || {}),
      p.is_hero ? 1 : 0
    ]);

    const sql = `INSERT INTO products 
      (name, brand, category, price, old_price, stock, image_url, description, features, specs, is_hero) 
      VALUES ?`;

    await pool.query(sql, [values]);
    res.status(201).json({ message: "Bulk upload successful" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE product
router.delete('/:id', auth, async (req, res) => {
  if (req.user?.role !== 'manager') return res.status(403).json({ message: 'Managers only' });
  
  try {
    await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ message: 'Deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Delete failed' });
  }
});

module.exports = router;
