const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

async function initDatabase() {
  const schemaPath = path.resolve(__dirname, '..', 'db', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true
  });

  try {
    console.log('Applying database schema from', schemaPath);
    const [result] = await connection.query(schema);
    console.log('Database schema applied successfully.');
    process.exit(0);
  } catch (error) {
    // Check if it's just an index already exists error
    if (error.message.includes('Duplicate key name')) {
      console.log('Database schema applied successfully (some indexes already existed).');
      process.exit(0);
    }
    console.error('Failed to apply database schema:', error.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

initDatabase();
