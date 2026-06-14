const crypto = require('crypto');

async function generateUniqueOrderNumber(pool) {
  const prefix = 'GF';
  let orderNumber = '';
  let attempts = 0;

  while (attempts < 10) {
    const randomPart = crypto.randomBytes(3).toString('hex').toUpperCase();
    orderNumber = `${prefix}${randomPart}`;

    const [rows] = await pool.query('SELECT id FROM orders WHERE order_number = ?', [orderNumber]);
    if (!rows.length) {
      return orderNumber;
    }

    attempts += 1;
  }

  throw new Error('Unable to generate a unique order number');
}

module.exports = {
  generateUniqueOrderNumber,
};
