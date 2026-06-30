const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const compression = require('compression');
const authRoutes = require('./routes/auth');
const shoppingRoutes = require('./routes/shopping');
const gamingCodesRoutes = require('./routes/gaming-codes');
const pool = require('./db');
const auth = require('./middleware/auth');
const helmet = require('helmet');

const app = express();

// Trust the VS Code Dev Tunnel reverse proxy to fix validation errors
app.set('trust proxy', 1);

// Performance optimizations
app.use(compression());

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Prevent caching of sensitive data
app.use((req, res, next) => {
  if (req.path.includes('/api/auth')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

app.use(cors({ 
  origin: process.env.CORS_ORIGIN || 'https://vercel.app', 
  credentials: true 
}));
app.use(express.json({ limit: '10mb' }));

// Cache static assets for 1 hour (3600 seconds)
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { 
  maxAge: '1h', 
  etag: false 
}));

app.use('/api/auth', authRoutes);
app.use('/api/shopping', shoppingRoutes);
app.use('/api/gaming-codes', gamingCodesRoutes);

// ========================================================
// TEMPORARY INTERNAL CLOUD SLUG MIGRATION FOR RAILWAY
// ========================================================
const slugify = (text) => {
  if (!text) return '';
  return text.toString().toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-');
};

async function runCloudSlugMigration() {
  try {
    console.log('[RAILWAY MIGRATION] Checking products schema for slug alignment...');
    
    // 1. Create the column structure if it doesn't exist yet
    try {
      await pool.query('ALTER TABLE products ADD COLUMN slug VARCHAR(255) DEFAULT NULL AFTER id;');
      console.log('[RAILWAY MIGRATION] Column "slug" appended to schema.');
    } catch (err) {
      console.log('[RAILWAY MIGRATION] Schema check cleared (slug column exists).');
    }

    // 2. Fetch records that lack a slug string
    const [products] = await pool.query('SELECT id, name FROM products WHERE slug IS NULL OR slug = ""');
    
    if (products.length > 0) {
      console.log(`[RAILWAY MIGRATION] Processing string mapping loops for ${products.length} records...`);
      
      for (let product of products) {
        let baseSlug = slugify(product.name);
        let uniqueSlug = baseSlug;
        let counter = 1;
        
        // Handle exact naming collisions cleanly
        while (true) {
          const [existing] = await pool.query('SELECT id FROM products WHERE slug = ? AND id != ?', [uniqueSlug, product.id]);
          if (existing.length === 0) break;
          uniqueSlug = `${baseSlug}-${counter}`;
          counter++;
        }
        
        await pool.query('UPDATE products SET slug = ? WHERE id = ?', [uniqueSlug, product.id]);
      }
      console.log('[RAILWAY MIGRATION] Slugs backfilled successfully.');
    }

    // 3. Enforce structural integrity constraints
    await pool.query('ALTER TABLE products MODIFY COLUMN slug VARCHAR(255) NOT NULL UNIQUE;');
    console.log('[RAILWAY MIGRATION] Integrity schema constraints successfully locked down (NOT NULL UNIQUE).');
  } catch (error) {
    console.error('[RAILWAY MIGRATION CORE EXCEPTION]:', error.message);
  }
}
// ========================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  
  // Triggers the data migration smoothly right when the cloud container starts up
  await runCloudSlugMigration();
});
