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

async function ensureSlugColumn(tableName) {
  try {
    await pool.query(`ALTER TABLE ${tableName} ADD COLUMN slug VARCHAR(255) DEFAULT NULL AFTER id;`);
    console.log(`Added slug column to ${tableName}.`);
  } catch (dbError) {
    if (dbError.code === 'ER_DUP_FIELDNAME' || dbError.message.includes('already exists')) {
      console.log(`Slug column already exists on ${tableName}, skipping.`);
    } else {
      throw dbError;
    }
  }
}

async function backfillTable(tableName) {
  const [rows] = await pool.query(`SELECT id, name FROM ${tableName} WHERE slug IS NULL OR slug = ''`);
  console.log(`Found ${rows.length} ${tableName} rows to update...`);

  for (const row of rows) {
    const baseSlug = slugify(row.name) || `${tableName}-item`;
    let uniqueSlug = baseSlug;
    let counter = 1;

    while (true) {
      const [existing] = await pool.query(`SELECT id FROM ${tableName} WHERE slug = ? AND id != ?`, [uniqueSlug, row.id]);
      if (existing.length === 0) break;
      uniqueSlug = `${baseSlug}-${counter}`;
      counter += 1;
    }

    await pool.query(`UPDATE ${tableName} SET slug = ? WHERE id = ?`, [uniqueSlug, row.id]);
    console.log(`Updated ${tableName} ID ${row.id}: ${uniqueSlug}`);
  }
}

async function backfill() {
  try {
    console.log('Ensuring slug columns exist in production...');
    await ensureSlugColumn('products');
    await ensureSlugColumn('gaming_codes');

    await backfillTable('products');
    await backfillTable('gaming_codes');

    console.log('Enforcing database constraints (Unique & Not Null)...');
    await pool.query('ALTER TABLE products MODIFY COLUMN slug VARCHAR(255) NOT NULL UNIQUE;');
    await pool.query('ALTER TABLE gaming_codes MODIFY COLUMN slug VARCHAR(255) NOT NULL UNIQUE;');

    console.log('All existing products and gaming codes successfully updated with unique production constraints!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

backfill();
