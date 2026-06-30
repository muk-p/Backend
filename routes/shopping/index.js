const express = require('express');
const router = express.Router();

const stats = require('./stats');
const products = require('./products');
const checkout = require('./checkout');
const orders = require('./orders');

// This will print to your Railway logs so you know exactly which file is broken!
console.log('Stats export type:', typeof stats);
console.log('Products export type:', typeof products);
console.log('Checkout export type:', typeof checkout);
console.log('Orders export type:', typeof orders);

router.use('/stats', stats);
router.use('/products', products);
router.use('/checkout', checkout);
router.use('/', orders);

module.exports = router;
