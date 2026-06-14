const express = require('express');
const router = express.Router();
const pool = require('../../db');
const { body, validationResult } = require('express-validator');
const auth = require('../../middleware/auth');
const { sendOrderEmail } = require('../../utils/mailer');
const { normalizeMpesaPhone } = require('../../utils/phone');
const { generateUniqueOrderNumber } = require('../../utils/orderNumber');

// GET all orders
router.get('/orders', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.id, o.order_number, o.buyer_id, b.name AS customer_name, b.email AS customer_email, o.address, o.payment_method, o.total_amount, o.status, o.merchant_request_id, o.created_at
       FROM orders o
       LEFT JOIN buyers b ON b.id = o.buyer_id
       ORDER BY o.created_at DESC`
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET single order with its items
router.get('/order/:identifier', async (req, res) => {
  const { identifier } = req.params;
  const searchValue = identifier?.trim();

  if (!searchValue) {
    return res.status(400).json({ message: 'Order identifier is required' });
  }

  try {
    const [orders] = await pool.query(
      `SELECT o.id, o.order_number, o.buyer_id, b.name AS customer_name, b.email AS customer_email, o.address, o.payment_method, o.total_amount, o.status, o.merchant_request_id, o.created_at
       FROM orders o
       LEFT JOIN buyers b ON b.id = o.buyer_id
       WHERE o.id = ? OR LOWER(o.order_number) = LOWER(?) OR LOWER(o.merchant_request_id) = LOWER(?)
       LIMIT 1`,
      [searchValue, searchValue, searchValue]
    );

    if (!orders.length) return res.status(404).json({ message: 'Order not found' });

    const order = orders[0];
    const [items] = await pool.query(
      `SELECT oi.product_id, oi.quantity, oi.price_at_purchase AS unit_price, p.name AS item_name
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ?`,
      [order.id]
    );

    res.json({ order, items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET Status of a Physical Hardware Order via MerchantRequestID
router.get('/orders/status/:merchantRequestId', async (req, res) => {
  const { merchantRequestId } = req.params;

  try {
    // 1. Updated query to select all fields from orders and customer details from buyers
    const [orders] = await pool.query(
      `SELECT o.id, o.order_number, o.buyer_id, b.name AS customer_name, b.email AS customer_email, 
              o.address, o.payment_method, o.total_amount, o.status, o.merchant_request_id, o.created_at
       FROM orders o
       LEFT JOIN buyers b ON b.id = o.buyer_id
       WHERE o.merchant_request_id = ?`,
      [merchantRequestId]
    );

    // If no order is found with that M-Pesa ID yet
    if (orders.length === 0) {
      return res.status(200).json({ 
        status: 'pending', 
        message: 'Order record initializing or payment still broadcasting...' 
      });
    }

    const order = orders[0];

    // 2. Fetch the items for this order so you have the products too
    const [items] = await pool.query(
      'SELECT product_id, quantity, price_at_purchase AS unit_price FROM order_items WHERE order_id = ?',
      [order.id]
    );

    // 3. Send back the complete order object and items array
    return res.status(200).json({
      order,
      items
    });

  } catch (error) {
    console.error('Failed to look up order status:', error.message);
    return res.status(500).json({ message: 'Internal server error checking status' });
  }
});

// CREATE a new order with INVENTORY MANAGEMENT
router.post(
  '/order',
  [
    body('items').isArray({ min: 1 }).withMessage('Order items are required'),
    body('items.*.productId').isInt().withMessage('Each item must include a productId'),
    body('items.*.quantity').isInt({ gt: 0 }).withMessage('Each item quantity must be a positive integer'),
    body('customerName').notEmpty().withMessage('Customer name is required'),
    body('customerEmail').isEmail().withMessage('Valid customer email is required'),
    body('address').notEmpty().withMessage('Shipping address is required'),
    body('paymentMethod').notEmpty().withMessage('Payment method is required'),
    body('mpesaPhone').optional().custom((value) => {
      if (!value) return true;
      if (!normalizeMpesaPhone(value)) {
        throw new Error('Mpesa phone must be formatted as 2547XXXXXXXX or 07XXXXXXXX');
      }
      return true;
    })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    let buyerId = req.user && req.user.id;
    if (!buyerId) {
      const [buyers] = await pool.query('SELECT id FROM buyers ORDER BY id LIMIT 1');
      if (!buyers.length) return res.status(500).json({ message: 'No buyer account configured' });
      buyerId = buyers[0].id;
    }

    const { items, customerName, customerEmail, address, paymentMethod, mpesaPhone, notes } = req.body;
    const normalizedPhone = paymentMethod === 'M-PESA' ? normalizeMpesaPhone(mpesaPhone) : null;
    const productIds = [...new Set(items.map(item => Number(item.productId)))];

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // 1. Fetch current price AND stock levels (Locked for update to prevent race conditions)
      const [products] = await connection.query(
        `SELECT id, name, price, stock FROM products WHERE id IN (${productIds.map(() => '?').join(',')}) FOR UPDATE`,
        productIds
      );

      const productMap = new Map(products.map(p => [p.id, p]));
      let totalAmount = 0;
      const orderItemsData = [];

      // 2. Validate Inventory before proceeding
      for (const item of items) {
        const product = productMap.get(Number(item.productId));
        if (!product) throw new Error(`Product ${item.productId} not found`);

        if (product.stock < item.quantity) {
          throw new Error(`Not enough stock for ${product.name}. Remaining: ${product.stock}`);
        }

        const unitPrice = Number(product.price);
        totalAmount += unitPrice * item.quantity;
        orderItemsData.push({
          productId: product.id,
          quantity: item.quantity,
          unitPrice: unitPrice,
          name: product.name
        });
      }

      // 3. Create main order record
      const orderNumber = await generateUniqueOrderNumber(connection);
      const [orderResult] = await connection.query(
        'INSERT INTO orders (buyer_id, address, payment_method, total_amount, status, merchant_request_id, order_number) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [buyerId, address, paymentMethod, totalAmount, 'pending', normalizedPhone ? `order-${Date.now()}` : null, orderNumber]
      );
      const orderId = orderResult.insertId;

      // 4. Update Inventory and Save Items
      for (const item of orderItemsData) {
        // Save to order_items
        await connection.query(
          'INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)',
          [orderId, item.productId, item.quantity, item.unitPrice]
        );

        // Deduct stock from products table
        await connection.query(
          'UPDATE products SET stock = stock - ? WHERE id = ?',
          [item.quantity, item.productId]
        );
      }

      await connection.commit();

      try {
        await sendOrderEmail({
          orderId, customerName, customerEmail, address, paymentMethod,
          items: orderItemsData, totalAmount
        });
      } catch (err) { console.error('Email error:', err); }

      res.status(201).json({ orderId, totalAmount, message: 'Order created and stock updated' });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      res.status(400).json({ message: error.message });
    } finally {
      connection.release();
    }
  }
);

// DELETE order
router.delete('/order/:id', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.query('DELETE FROM orders WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Order not found' });
    res.json({ message: 'Order deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Mock payment endpoint
router.post('/payment', async (req, res) => {
  const { amount, paymentMethod } = req.body;
  res.json({ status: 'success', paymentId: `mock_${Date.now()}`, amount, paymentMethod });
});

module.exports = router;
