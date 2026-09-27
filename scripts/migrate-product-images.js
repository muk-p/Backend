const mysql = require('mysql2/promise');
require('dotenv').config();

async function migrateProductImages() {
  const database = process.env.DB_NAME || 'gadgetfinds';
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database,
  });

  try {
    const [columns] = await connection.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'products' AND COLUMN_NAME = 'images'`,
      [database]
    );

    if (!columns.length) {
      await connection.query('ALTER TABLE products ADD COLUMN images JSON NULL AFTER image_url');
      console.log('Added products.images JSON column.');
    } else {
      console.log('products.images column already exists.');
    }

    const [result] = await connection.query(
      `UPDATE products
       SET images = JSON_ARRAY(image_url)
       WHERE images IS NULL AND image_url IS NOT NULL AND image_url <> ''`
    );
    console.log(`Initialized image galleries for ${result.affectedRows} products.`);
  } finally {
    await connection.end();
  }
}

migrateProductImages().catch((error) => {
  console.error('Failed to migrate product images:', error.message);
  process.exitCode = 1;
});