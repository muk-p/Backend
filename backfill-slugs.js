require('dotenv').config(); // 👈 ADD THIS AT THE VERY TOP

const pool = require('./db'); // Match your database file location

const slugify = (text) => {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-');
};

async function backfill() {
  try {
    console.log('Ensuring slug column exists in production...');
    try {
      await pool.query('ALTER TABLE products ADD COLUMN slug VARCHAR(255) DEFAULT NULL AFTER id;');
      console.log('Column created successfully.');
    } catch (dbError) {
      if (dbError.code === 'ER_DUP_FIELDNAME' || dbError.message.includes('already exists')) {
        console.log('Slug column already exists, skipping creation step...');
      } else {
        throw dbError;
      }
    }

    // 1. Fetch all products missing a slug
    const [products] = await pool.query('SELECT id, name FROM products WHERE slug IS NULL OR slug = ""');
    console.log(`Found ${products.length} products to update...`);

    for (let product of products) {
      let baseSlug = slugify(product.name);
      let uniqueSlug = baseSlug;
      let counter = 1;

      // 2. Loop check to handle exact duplicate names cleanly
      while (true) {
        const [existing] = await pool.query('SELECT id FROM products WHERE slug = ? AND id != ?', [uniqueSlug, product.id]);
        if (existing.length === 0) break;
        uniqueSlug = `${baseSlug}-${counter}`;
        counter++;
      }

      // 3. Save the newly generated slug back to the item
      await pool.query('UPDATE products SET slug = ? WHERE id = ?', [uniqueSlug, product.id]);
      console.log(`Updated ID ${product.id}: ${uniqueSlug}`);
    }

    console.log('Enforcing database constraints (Unique & Not Null)...');
    await pool.query('ALTER TABLE products MODIFY COLUMN slug VARCHAR(255) NOT NULL UNIQUE;');

    console.log('All existing products successfully updated with unique production constraints!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

backfill();
