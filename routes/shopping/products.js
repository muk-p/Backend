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

// Helper function to generate clean slugs from product names
const slugify = (text) => {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')         // Replace spaces with -
    .replace(/[^\w\-]+/g, '')     // Remove all non-word chars
    .replace(/\-\-+/g, '-');      // Replace multiple - with single -
};

// 1. GROUPED CATEGORY ROUTE (Optimized for instantaneous mobile rendering)
router.get('/', productLimiter, async (req, res) => {
  try {
    const limit = 80; // High safe threshold since indexation handles structure calculations

    res.set('Cache-Control', 'public, max-age=600, s-maxage=1200, stale-while-revalidate=60');
    
    // SQL ORDER ENGINE (Swapped 'id' selections and order fallbacks to 'slug')
    const [rows] = await pool.query(
      `SELECT slug, name, brand, category, price, old_price, stock, image_url, is_hero, features, specs 
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
         slug ASC
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
      `SELECT slug, name, price, old_price, image_url, is_hero 
       FROM products 
       WHERE is_hero = 1 
       ORDER BY slug DESC`
    );
    res.json({ products: rows });
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching hero banners' });
  }
});

// 2. GET SINGLE PRODUCT (Switched from :id parameter to :slug)
router.get('/:slug', productLimiter, async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=3600');
    const [rows] = await pool.query('SELECT * FROM products WHERE slug = ?', [req.params.slug]);
    
    if (!rows.length) return res.status(404).json({ message: 'Product not found' });
    
    const p = rows[0];
    const product = {
      ...p,
      is_hero: !!p.is_hero,
      features: typeof p.features === 'string' ? JSON.parse(p.features || '[]') : (p.features || []),
      specs: typeof p.specs === 'string' ? JSON.parse(p.specs || '{}') : (p.specs || {})
    };
    
    res.json({ product });
  } catch (error) {
    console.error("Fetch Error:", error);
    res.status(500).json({ message: 'Server error' });
  }
});

// 3. POST NEW PRODUCT (Switched registration returns to slug targets)
router.post('/', auth, upload.single('image'), async (req, res) => {
  if (req.user?.role !== 'manager') return res.status(403).json({ message: 'Managers only' });

  const { 
    name, brand, category, price, old_price, stock, 
    description, features, specs, is_hero, slug 
  } = req.body;

  // Use the provided slug, or auto-generate one from the name if empty
  const productSlug = slug ? slugify(slug) : slugify(name);
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
      (slug, name, brand, category, price, old_price, stock, image_url, description, features, specs, is_hero) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        productSlug,
        name, brand, category, price, old_price || null, stock || 0, image_url, description, 
        parseJsonField(features, true), 
        parseJsonField(specs, false),
        is_hero === 'true' || is_hero === true || is_hero == 1 ? 1 : 0
      ]
    );

    res.status(201).json({ 
      slug: productSlug, 
      ...req.body, 
      image_url, 
      is_hero: !!is_hero 
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'A product with this slug or name already exists' });
    }
    res.status(500).json({ message: 'Database error', detail: error.message });
  }
});

// 4. PUT UPDATE PRODUCT (Using slug as parameter and updating values)
router.put('/:slug', auth, upload.single('image'), async (req, res) => {
  if (req.user?.role !== 'manager') return res.status(403).json({ message: 'Managers only' });
  const currentSlug = req.params.slug;
  const { name, brand, category, price, old_price, stock, description, features, specs, is_hero, slug } = req.body;

  let image_url = req.body.image_url;
  if (req.file) {
    image_url = `/uploads/${req.file.filename}`;
  } else if (image_url && image_url.includes('http')) {
    const urlParts = image_url.split('/uploads/');
    if (urlParts.length > 1) image_url = `/uploads/${urlParts[1]}`;
  }

  // Update to a new slug if specified, otherwise fall back to current slug or newly slugified name
  const updatedSlug = slug ? slugify(slug) : (name ? slugify(name) : currentSlug);

  const parseJsonField = (field, isArray = true) => {
    if (!field) return JSON.stringify(isArray ? [] : {});
    if (typeof field === 'object') return JSON.stringify(field);
    try { return JSON.stringify(JSON.parse(field)); } 
    catch { return JSON.stringify(isArray ? [] : {}); }
  };

  try {
    const query = `
      UPDATE products 
      SET slug = ?, name = ?, brand = ?, category = ?, price = ?, old_price = ?, 
          stock = ?, description = ?, features = ?, specs = ?, image_url = ?, is_hero = ?
      WHERE slug = ?
    `;
    
    const values = [
      updatedSlug,
      name, brand || null, category, parseFloat(price), 
      old_price ? parseFloat(old_price) : null,
      parseInt(stock) || 0, description || '',
      parseJsonField(features, true), parseJsonField(specs, false),
      image_url,
      is_hero === 'true' || is_hero === true || is_hero == 1 ? 1 : 0,
      currentSlug
    ];

    const [result] = await pool.query(query, values);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Product not found' });

    res.json({ 
      message: 'Product updated successfully', 
      slug: updatedSlug, 
      is_hero: !!is_hero 
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'The new slug or name conflicts with an existing product' });
    }
    res.status(500).json({ message: 'Update failed', detail: error.message });
  }
});

// 5. BULK UPLOAD (With automatic slugification for each array item)
router.post('/bulk', auth, async (req, res) => {
  const products = req.body;
  if (!Array.isArray(products)) return res.status(400).json({ message: "Expected an array" });

  try {
    const values = products.map(p => [
      p.slug ? slugify(p.slug) : slugify(p.name), // Ensures every bulk entry gets a slug
      p.name, p.brand, p.category, p.price, p.old_price || null, p.stock || 0, 
      p.image_url, p.description, 
      JSON.stringify(p.features || []), 
      JSON.stringify(p.specs || {}),
      p.is_hero ? 1 : 0
    ]);

    const sql = `INSERT INTO products 
      (slug, name, brand, category, price, old_price, stock, image_url, description, features, specs, is_hero) 
      VALUES ?`;

    await pool.query(sql, [values]);
    res.status(201).json({ message: "Bulk upload successful" });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'Bulk insert failed due to duplicate slugs or names', detail: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

// 6. DELETE PRODUCT (Explicitly isolated parameter scope)
router.route('/:slug')
  .delete(auth, async (req, res) => {
    if (req.user?.role !== 'manager') {
      return res.status(403).json({ message: 'Managers only' });
    }
    
    try {
      // Execute explicit parameterized deletion targeting slug indices
      const [result] = await pool.query(
        'DELETE FROM products WHERE slug = ?', 
        [req.params.slug]
      );
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Product not found' });
      }
      
      return res.json({ message: 'Deleted successfully' });
    } catch (error) {
      console.error("Delete Endpoint Error:", error);
      return res.status(500).json({ message: 'Delete execution pipeline failure' });
    }
  });

module.exports = router;
