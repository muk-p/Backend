const express = require('express');
const router = express.Router();

router.use('/stats', require('./stats'));
router.use('/products', require('./products'));
router.use('/checkout', require('./checkout'));
router.use('/', require('./orders'));

module.exports = router;
