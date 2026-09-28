const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const confirmedDatabase = args.find((arg) => arg.startsWith('--confirm-staging='))?.split('=')[1];
const databaseName = process.env.DB_NAME || 'gadgetfinds';

if (!execute) {
  console.log(`Dry run only. Target database name: ${databaseName}`);
  console.log('No database connection or changes made.');
  console.log('For staging only, configure a staging .env whose DB_NAME contains "staging", then pass that exact name:');
  console.log('npm run migrate:phone-variants -- --execute --confirm-staging=<staging-database-name>');
  process.exit(0);
}

if (!databaseName.toLowerCase().includes('staging') || confirmedDatabase !== databaseName) {
  console.error('Refusing migration: DB_NAME must include "staging" and must be confirmed exactly.');
  process.exit(1);
}

async function migrate() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: databaseName,
  });

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS phone_variants (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        variant_label VARCHAR(120) NOT NULL,
        market VARCHAR(80) NOT NULL DEFAULT 'Standard',
        warranty VARCHAR(120) NOT NULL DEFAULT '',
        price DECIMAL(10,2) NOT NULL,
        stock INT NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_phone_variant (product_id, variant_label, market, warranty),
        INDEX idx_phone_variants_active (product_id, is_active),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);

    const [columns] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'order_items' AND COLUMN_NAME = 'phone_variant_id'`,
      [databaseName]
    );
    if (!columns.length) {
      await connection.query('ALTER TABLE order_items ADD COLUMN phone_variant_id INT NULL AFTER product_id');
    }

    const [indexes] = await connection.query(
      `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'order_items' AND INDEX_NAME = 'idx_order_items_phone_variant'`,
      [databaseName]
    );
    if (!indexes.length) {
      await connection.query('CREATE INDEX idx_order_items_phone_variant ON order_items(phone_variant_id)');
    }

    const [constraints] = await connection.query(
      `SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'order_items' AND CONSTRAINT_NAME = 'fk_order_items_phone_variant'`,
      [databaseName]
    );
    if (!constraints.length) {
      await connection.query(`
        ALTER TABLE order_items
        ADD CONSTRAINT fk_order_items_phone_variant
        FOREIGN KEY (phone_variant_id) REFERENCES phone_variants(id) ON DELETE RESTRICT
      `);
    }

    console.log('Phone variants migration completed successfully.');
  } finally {
    await connection.end();
  }
}

migrate().catch((error) => {
  console.error('Phone variants migration failed:', error.message);
  process.exitCode = 1;
});
