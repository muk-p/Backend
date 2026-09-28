const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { parse } = require('csv-parse/sync');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const confirmedDatabase = args.find((arg) => arg.startsWith('--confirm-staging='))?.split('=')[1];
const databaseName = process.env.DB_NAME || 'gadgetfinds';
const backendRoot = path.resolve(__dirname, '..');

function readCsv(fileName) {
  return parse(fs.readFileSync(path.join(backendRoot, fileName)), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
}

function validate(products, variants) {
  const productSlugs = new Set(products.map((product) => product.slug));
  if (productSlugs.size !== products.length) throw new Error('Duplicate product slugs in products-phones.csv');

  for (const product of products) {
    if (!product.slug || !product.name || !['Samsung', 'Apple', 'Nothing'].includes(product.brand)) {
      throw new Error(`Invalid parent product row: ${product.slug || '(missing slug)'}`);
    }
    if (!Number.isFinite(Number(product.price)) || Number(product.price) <= 0) {
      throw new Error(`Invalid parent price for ${product.slug}`);
    }
    JSON.parse(product.images || '[]');
    JSON.parse(product.features || '[]');
    JSON.parse(product.specs || '{}');
  }

  const variantKeys = new Set();
  const lowestPrices = new Map();
  for (const variant of variants) {
    if (!productSlugs.has(variant.product_slug)) throw new Error(`Unknown product slug: ${variant.product_slug}`);
    if (!variant.variant_label || !variant.market || !variant.warranty) {
      throw new Error(`Missing variant label, market, or warranty for ${variant.product_slug}`);
    }
    for (const field of ['ram_gb', 'storage_gb']) {
      if (variant[field] && (!Number.isInteger(Number(variant[field])) || Number(variant[field]) <= 0)) {
        throw new Error(`Invalid ${field} for ${variant.product_slug} ${variant.variant_label}`);
      }
    }
    if (!Number.isInteger(Number(variant.stock)) || Number(variant.stock) < 0) {
      throw new Error(`Invalid stock for ${variant.product_slug} ${variant.variant_label}`);
    }
    const price = Number(variant.price_ksh);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Invalid variant price for ${variant.product_slug}`);
    const key = [variant.product_slug, variant.variant_label, variant.market, variant.warranty].join('\0');
    if (variantKeys.has(key)) throw new Error(`Duplicate variant row: ${variant.product_slug} ${variant.variant_label}`);
    variantKeys.add(key);
    lowestPrices.set(variant.product_slug, Math.min(lowestPrices.get(variant.product_slug) ?? Infinity, price));
  }

  for (const product of products) {
    if (Number(product.price) !== lowestPrices.get(product.slug)) {
      throw new Error(`Parent price must equal the lowest variant price for ${product.slug}`);
    }
  }
}

async function importCatalog() {
  const products = readCsv('products-phones.csv');
  const variants = readCsv('phone-variants.csv');
  validate(products, variants);

  console.log(`Validated ${products.length} parent products and ${variants.length} variants.`);
  if (!execute) {
    console.log(`Dry run only. Target database name: ${databaseName}`);
    console.log('No database connection or changes made.');
    console.log('For staging only, configure a staging .env whose DB_NAME contains "staging", then pass that exact name:');
    console.log('npm run import:phones -- --execute --confirm-staging=<staging-database-name>');
    return;
  }

  if (!databaseName.toLowerCase().includes('staging') || confirmedDatabase !== databaseName) {
    throw new Error('Refusing import: DB_NAME must include "staging" and must be confirmed exactly.');
  }

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: databaseName,
  });

  try {
    await connection.beginTransaction();
    const productIds = new Map();

    for (const product of products) {
      const [result] = await connection.query(
        `INSERT INTO products
          (slug, name, brand, category, price, old_price, stock, image_url, images, description, features, specs, is_hero)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          name = VALUES(name), brand = VALUES(brand), category = VALUES(category), price = VALUES(price),
          old_price = COALESCE(VALUES(old_price), old_price),
          image_url = COALESCE(VALUES(image_url), image_url),
          images = IF(JSON_LENGTH(VALUES(images)) = 0, images, VALUES(images)),
          description = IF(VALUES(description) IS NULL OR TRIM(VALUES(description)) = '', description, VALUES(description)),
          features = IF(JSON_LENGTH(VALUES(features)) = 0, features, VALUES(features)),
          specs = IF(JSON_LENGTH(VALUES(specs)) = 0, specs, VALUES(specs)),
          is_hero = VALUES(is_hero)`,
        [
          product.slug,
          product.name,
          product.brand,
          product.category,
          Number(product.price),
          product.old_price ? Number(product.old_price) : null,
          Number(product.stock || 0),
          product.image_url || null,
          JSON.stringify(JSON.parse(product.images || '[]')),
          product.description || null,
          JSON.stringify(JSON.parse(product.features || '[]')),
          JSON.stringify(JSON.parse(product.specs || '{}')),
          product.is_hero === '1' ? 1 : 0,
        ]
      );
      const [rows] = await connection.query('SELECT id FROM products WHERE slug = ?', [product.slug]);
      productIds.set(product.slug, rows[0]?.id || result.insertId);
    }

    for (const variant of variants) {
      await connection.query(
        `INSERT INTO phone_variants
          (product_id, variant_label, ram_gb, storage_gb, market, warranty, price, stock, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
          ram_gb = VALUES(ram_gb), storage_gb = VALUES(storage_gb), price = VALUES(price), is_active = 1`,
        [
          productIds.get(variant.product_slug),
          variant.variant_label,
          variant.ram_gb ? Number(variant.ram_gb) : null,
          variant.storage_gb ? Number(variant.storage_gb) : null,
          variant.market,
          variant.warranty,
          Number(variant.price_ksh),
          Number(variant.stock),
        ]
      );
    }

    await connection.commit();
    console.log(`Imported ${products.length} parent products and ${variants.length} variants into ${databaseName}.`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

importCatalog().catch((error) => {
  console.error('Phone catalog import failed:', error.message);
  process.exitCode = 1;
});
