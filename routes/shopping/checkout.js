const express = require('express');
const router = express.Router();
const pool = require('../../db');
const axios = require('axios');
const { body, validationResult } = require('express-validator');
const { normalizeMpesaPhone } = require('../../utils/phone');
const { generateUniqueOrderNumber } = require('../../utils/orderNumber');

const pendingCheckoutSessions = new Map();

// Helper Function: Fetch short-lived Daraja Access Token
async function getDarajaToken() {
  const key = process.env.DARAJA_CONSUMER_KEY;
  const secret = process.env.DARAJA_CONSUMER_SECRET;
  
  if (!key || !secret) {
    throw new Error('Daraja credentials are missing in environment variables');
  }

  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  
  try {
    const response = await axios.get(
      'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      { 
        headers: { 
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        } 
      }
    );
    return response.data.access_token;
  } catch (error) {
    console.error('--- DARAJA TOKEN FAILURE ENGINE LOG ---');
    console.error('HTTP Rejection Status:', error.response?.status);
    console.error('Error Response Data:', error.response?.data);
    throw new Error(`M-Pesa Token Error: ${error.response?.data?.errorMessage || error.message}`);
  }
}

router.post(
  '/',
  [
    body('items').isArray({ min: 1 }).withMessage('Order items are required'),
    body('items.*.productId').isInt().withMessage('Each item must include a productId'),
    body('items.*.quantity').isInt({ gt: 0 }).withMessage('Each item quantity must be a positive integer'),
    body('customerName').notEmpty().withMessage('Customer name is required'),
    body('address').notEmpty().withMessage('Shipping address is required'),
    body('paymentMethod').notEmpty().withMessage('Payment method is required'),
    body('mpesaPhone').custom((value) => {
      if (!value) {
        throw new Error('Mpesa phone is required');
      }

      if (!normalizeMpesaPhone(value)) {
        throw new Error('Mpesa phone must be formatted as 2547XXXXXXXX or 07XXXXXXXX');
      }

      return true;
    })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    // Identify active authenticated buyer session profile ID
    let buyerId = req.user && req.user.id;
    
    if (!buyerId) {
      const [buyers] = await pool.query('SELECT id FROM buyers ORDER BY id LIMIT 1');
      if (!buyers.length) {
        return res.status(500).json({ message: 'No registered buyer accounts exist to map this order reference.' });
      }
      buyerId = buyers[0].id;
    }

    const { items, customerName, address, paymentMethod, mpesaPhone } = req.body;
    const normalizedPhone = paymentMethod === 'M-PESA' ? normalizeMpesaPhone(mpesaPhone) : null;

    if (paymentMethod === 'M-PESA' && !normalizedPhone) {
      return res.status(400).json({ message: 'A valid M-Pesa number is required for M-PESA payments' });
    }

    const productIds = [...new Set(items.map(item => Number(item.productId)))].filter(id => Number.isInteger(id));

    if (!productIds.length) {
      return res.status(400).json({ message: 'Invalid product IDs in order items' });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // Row locking stock layout configurations for transaction processing safety
      const [products] = await connection.query(
        `SELECT id, name, price, stock FROM products WHERE id IN (${productIds.map(() => '?').join(',')}) FOR UPDATE`,
        productIds
      );

      const productMap = new Map(products.map(p => [p.id, p]));
      let totalAmount = 0;
      const orderItemsData = [];

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
          unitPrice,
          name: product.name
        });
      }

      // -------------------------------------------------------------
      // DARAJA M-PESA STK PUSH INTEGRATION BLOCK
      // -------------------------------------------------------------
      let darajaResponseData = null;
      let paymentInitiated = false;
      let paymentErrorMessage = null;

      if (paymentMethod === 'M-PESA') {
        try {
          const accessToken = await getDarajaToken();
          const shortCode = '174379';
          const passkey = process.env.DARAJA_PASSKEY;
          const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
          const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
          const payableAmount = Math.round(totalAmount);

          const stkPayload = {
            BusinessShortCode: shortCode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: payableAmount,
            PartyA: normalizedPhone,
            PartyB: shortCode,
            PhoneNumber: normalizedPhone,
            CallBackURL: `${process.env.BACKEND_URL}/api/shopping/checkout/mpesa-callback`,
            AccountReference: `Order_Ref`,
            TransactionDesc: `Payment for order`
          };

          const darajaRes = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            stkPayload,
            {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
              }
            }
          );
          darajaResponseData = darajaRes.data;
          paymentInitiated = Boolean(darajaResponseData?.MerchantRequestID);
        } catch (stkError) {
          console.error('Daraja Gateway Error Details:', stkError.response?.data || stkError.message);
          paymentErrorMessage = `M-Pesa prompt could not be started right now: ${stkError.response?.data?.CustomerMessage || stkError.message}`;
        }
      }
      // -------------------------------------------------------------

      const mpesaTrackingId = darajaResponseData?.MerchantRequestID || null;

      if (paymentMethod === 'M-PESA' && paymentInitiated && mpesaTrackingId) {
        pendingCheckoutSessions.set(mpesaTrackingId, {
          buyerId,
          address,
          paymentMethod,
          totalAmount,
          orderItemsData,
          customerName,
        });
      }

      if (paymentMethod !== 'M-PESA') {
        const orderNumber = await generateUniqueOrderNumber(connection);
        const [orderResult] = await connection.query(
          'INSERT INTO orders (buyer_id, address, payment_method, total_amount, status, merchant_request_id, order_number) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [buyerId, address, paymentMethod, totalAmount, 'processing', null, orderNumber]
        );
        const orderId = orderResult.insertId;

        for (const item of orderItemsData) {
          await connection.query(
            'INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)',
            [orderId, item.productId, item.quantity, item.unitPrice]
          );
          await connection.query(
            'UPDATE products SET stock = stock - ? WHERE id = ?',
            [item.quantity, item.productId]
          );
        }

        await connection.commit();

        return res.status(201).json({
          orderId,
          orderNumber,
          totalAmount,
          paymentInitiated: true,
          message: 'Order created successfully.',
          MerchantRequestID: null,
        });
      }

      await connection.commit();

      res.status(201).json({
        totalAmount,
        paymentInitiated,
        message: paymentInitiated
          ? 'Checkout execution complete, database committed, STK prompt triggered.'
          : paymentErrorMessage || 'We could not start the M-Pesa prompt right now.',
        MerchantRequestID: mpesaTrackingId
      });

    } catch (error) {
      await connection.rollback();
      console.error('Checkout Transaction Aborted:', error.message);
      res.status(400).json({ message: error.message });
    } finally {
      connection.release();
    }
  }
);

// Callback Endpoint for Safaricom Daraja Processing Engine
router.post('/mpesa-callback', async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Callback accepted successfully" });

  let connection;
  try {
    const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc } = req.body.Body.stkCallback;
    
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const pendingSession = pendingCheckoutSessions.get(MerchantRequestID);

    if (ResultCode !== 0) {
      console.warn(`Payment failed or canceled by user: ${ResultDesc} (${ResultCode})`);
      pendingCheckoutSessions.delete(MerchantRequestID);
      
      const [hardwareCheck] = await connection.query(
        'SELECT id FROM orders WHERE merchant_request_id = ?',
        [MerchantRequestID]
      );

      if (hardwareCheck.length > 0) {
        const orderId = hardwareCheck[0].id;
        
        await connection.query(
          'UPDATE orders SET status = "canceled" WHERE id = ?',
          [orderId]
        );

        const [items] = await connection.query(
          'SELECT product_id, quantity FROM order_items WHERE order_id = ?',
          [orderId]
        );
        for (const item of items) {
          await connection.query(
            'UPDATE products SET stock = stock + ? WHERE id = ?',
            [item.quantity, item.product_id]
          );
        }
      }

      await connection.query(
        'UPDATE gaming_code_purchases SET status = "failed" WHERE merchant_request_id = ?',
        [MerchantRequestID]
      );

      await connection.commit();
      return;
    }
    console.log(`Payment successful for merchant request: ${MerchantRequestID}`);

    if (pendingSession) {
      const orderNumber = await generateUniqueOrderNumber(connection);
      const [orderResult] = await connection.query(
        'INSERT INTO orders (buyer_id, address, payment_method, total_amount, status, merchant_request_id, order_number) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [pendingSession.buyerId, pendingSession.address, pendingSession.paymentMethod, pendingSession.totalAmount, 'processing', MerchantRequestID, orderNumber]
      );
      const orderId = orderResult.insertId;

      for (const item of pendingSession.orderItemsData) {
        await connection.query(
          'INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)',
          [orderId, item.productId, item.quantity, item.unitPrice]
        );
        await connection.query(
          'UPDATE products SET stock = stock - ? WHERE id = ?',
          [item.quantity, item.productId]
        );
      }

      pendingCheckoutSessions.delete(MerchantRequestID);
      await connection.commit();
      console.log(`Hardware Order ID ${orderId} has been paid and moved to PROCESSING with order number ${orderNumber}.`);
      return;
    }

    const [hardwareOrders] = await connection.query(
      'SELECT id FROM orders WHERE merchant_request_id = ?',
      [MerchantRequestID]
    );

    if (hardwareOrders.length > 0) {
      const orderId = hardwareOrders[0].id;

      await connection.query(
        'UPDATE orders SET status = "processing" WHERE id = ?',
        [orderId]
      );

      await connection.commit();
      console.log(`Hardware Order ID ${orderId} has been paid and moved to PROCESSING.`);
      return;
    }

    const [digitalPurchases] = await connection.query(
      'SELECT id, buyer_id, gaming_code_id FROM gaming_code_purchases WHERE merchant_request_id = ?',
      [MerchantRequestID]
    );

    if (digitalPurchases.length > 0) {
      const purchase = digitalPurchases[0];

      const [availableCodes] = await connection.query(
        'SELECT id FROM gaming_code_inventory WHERE gaming_code_id = ? AND status = "available" LIMIT 1 FOR UPDATE',
        [purchase.gaming_code_id]
      );

      if (availableCodes.length === 0) {
        await connection.query(
          'UPDATE gaming_code_purchases SET status = "refund_required" WHERE id = ?',
          [purchase.id]
        );
        await connection.commit();
        console.error(`Digital stock empty for product ID ${purchase.gaming_code_id}! Marked as refund_required.`);
        return;
      }

      const assignedInventoryId = availableCodes[0].id;

      await connection.query(
        `UPDATE gaming_code_inventory 
         SET status = "sold", buyer_id = ?, sold_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [purchase.buyer_id, assignedInventoryId]
      );

      // Complete the master digital purchase log record entry
      await connection.query(
        `UPDATE gaming_code_purchases 
         SET status = "completed", inventory_id = ? 
         WHERE id = ?`,
        [assignedInventoryId, purchase.id]
      );

      await connection.commit();
      console.log(`Digital key ID ${assignedInventoryId} successfully distributed to buyer ${purchase.buyer_id}`);
      return;
    }

    console.warn(`Unmapped tracking transaction signature detected: ${MerchantRequestID}`);
    await connection.rollback();

  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Failed to process incoming payment callback database injection:', err.message);
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
