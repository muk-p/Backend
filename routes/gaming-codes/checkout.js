const express = require('express');
const router = express.Router();
const axios = require('axios');
const pool = require('../../db');
const auth = require('../../middleware/auth');
const { body, validationResult } = require('express-validator');
const { sendGamingCodeEmail } = require('../../utils/mailer');

// HELPER: Generate Safaricom OAuth Access Token
const getMpesaToken = async () => {
  const authHeader = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');
  
  const response = await axios.get(
    'https://safaricom.co.ke',
    { headers: { Authorization: `Basic ${authHeader}` } }
  );
  return response.data.access_token;
};

// ==========================================
// 1. INITIALIZE CHECKOUT (Triggers STK Push Window)
// ==========================================
router.post(
  '/purchase/:id',
  auth,
  [
    body('mpesaPhone').matches(/^254\d{9}$/).withMessage('Phone format must be 254XXXXXXXXX')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { id } = req.params;
    const { mpesaPhone } = req.body;
    const buyerId = req.user.id;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // Preliminary look at base inventory availability
      const [available] = await connection.query(
        'SELECT id FROM gaming_code_inventory WHERE gaming_code_id = ? AND status = "available" LIMIT 1',
        [id]
      );
      if (!available.length) {
        await connection.rollback();
        return res.status(400).json({ message: 'Gaming item code out of stock' });
      }

      // Grab static item details
      const [itemDetails] = await connection.query(
        'SELECT name, price FROM gaming_codes WHERE id = ?',
        [id]
      );
      if (!itemDetails.length) {
        await connection.rollback();
        return res.status(404).json({ message: 'Target entry item not found' });
      }

      const itemPrice = Math.round(itemDetails[0].price); // Cast to integer for Daraja

      // Build Daraja Crypto Key Requirements
      const token = await getMpesaToken();
      const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
      const password = Buffer.from(
        `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
      ).toString('base64');

      // Dispatch STK API Handshake
      const stkResponse = await axios.post(
        'https://safaricom.co.ke',
        {
          BusinessShortCode: process.env.MPESA_SHORTCODE,
          Password: password,
          Timestamp: timestamp,
          TransactionType: 'CustomerPayBillOnline',
          Amount: itemPrice,
          PartyA: mpesaPhone,
          PartyB: process.env.MPESA_SHORTCODE,
          PhoneNumber: mpesaPhone,
          CallBackURL: process.env.MPESA_CALLBACK_URL,
          AccountReference: `GF-${id}`,
          TransactionDesc: `Purchase ${itemDetails[0].name}`
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Create tracking entry into updated `gaming_code_purchases`
      await connection.query(
        `INSERT INTO gaming_code_purchases 
         (buyer_id, gaming_code_id, inventory_id, purchase_price, mpesa_phone, merchant_request_id, status) 
         VALUES (?, ?, NULL, ?, ?, ?, 'pending')`,
        [buyerId, id, itemPrice, mpesaPhone, stkResponse.data.MerchantRequestID]
      );

      await connection.commit();

      res.status(200).json({
        message: 'STK prompt pushed to handset device. Complete transaction on screen.',
        merchantRequestId: stkResponse.data.MerchantRequestID
      });

    } catch (error) {
      await connection.rollback();
      console.error('STK Dispatch Failure:', error.response?.data || error.message);
      res.status(500).json({ message: 'Failed to initiate M-Pesa gateway transaction.' });
    } finally {
      connection.release();
    }
  }
);

// ==========================================
// 2. M-PESA WEBHOOK CALLBACK (Asynchronous Engine)
// ==========================================
router.post('/mpesa-callback', async (req, res) => {
  // Safe validation check for structural errors from Daraja response
  if (!req.body.Body || !req.body.Body.stkCallback) {
    return res.status(400).json({ message: 'Invalid payload format' });
  }

  // Acknowledge payload reception to Safaricom immediately
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback received successfully' });

  const { MerchantRequestID, ResultCode, ResultDesc } = req.body.Body.stkCallback;

  // Handle user cancelled / transaction rejected actions
  if (ResultCode !== 0) {
    console.warn(`M-Pesa payment aborted [${MerchantRequestID}]: ${ResultDesc}`);
    await pool.query(
      'UPDATE gaming_code_purchases SET status = "failed" WHERE merchant_request_id = ? AND status = "pending"',
      [MerchantRequestID]
    );
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Read and Lock the pending transaction row
    const [purchaseRecords] = await connection.query(
      'SELECT id, buyer_id, gaming_code_id, purchase_price FROM gaming_code_purchases WHERE merchant_request_id = ? AND status = "pending" FOR UPDATE',
      [MerchantRequestID]
    );

    if (!purchaseRecords.length) {
      await connection.rollback();
      return;
    }
    const currentTx = purchaseRecords[0];

    // 2. Lock and extract an active unassigned token code line item
    const [assignedStock] = await connection.query(
      'SELECT id, code FROM gaming_code_inventory WHERE gaming_code_id = ? AND status = "available" LIMIT 1 FOR UPDATE',
      [currentTx.gaming_code_id]
    );

    // edge case protection: what happens if inventory dropped while user was typing PIN?
    if (!assignedStock.length) {
      await connection.query(
        'UPDATE gaming_code_purchases SET status = "refund_required" WHERE id = ?',
        [currentTx.id]
      );
      await connection.commit();
      console.error(`STOCK EXHAUSTION ERROR: Purchase reference ${currentTx.id} flagged for structural admin refund.`);
      return;
    }
    const actualCodeItem = assignedStock[0];

    // 3. Mark Code Inventory block as sold
    await connection.query(
      'UPDATE gaming_code_inventory SET status = "sold", sold_at = NOW(), buyer_id = ? WHERE id = ?',
      [currentTx.buyer_id, actualCodeItem.id]
    );

    // 4. Update core checkout details log state
    await connection.query(
      'UPDATE gaming_code_purchases SET status = "completed", inventory_id = ? WHERE id = ?',
      [actualCodeItem.id, currentTx.id]
    );

    // 5. Gather notification entity values for mailing utility engine
    const [buyerIdentity] = await connection.query('SELECT email FROM buyers WHERE id = ?', [currentTx.buyer_id]);
    const [gameIdentity] = await connection.query('SELECT name FROM gaming_codes WHERE id = ?', [currentTx.gaming_code_id]);

    await connection.commit();

    // 6. Asynchronous email delivery outside the SQL lock block context
    if (buyerIdentity.length && gameIdentity.length) {
      try {
        await sendGamingCodeEmail({
          email: buyerIdentity[0].email,
          gameName: gameIdentity[0].name,
          code: actualCodeItem.code,
          price: currentTx.purchase_price,
          purchasedAt: new Date()
        });
      } catch (mailError) {
        console.error('Webhook execution finished but email delivery system crashed:', mailError.message);
      }
    }

  } catch (err) {
    await connection.rollback();
    console.error('Critical transactional breakdown executing webhook payload process:', err);
  } finally {
    connection.release();
  }
});

module.exports = router;
