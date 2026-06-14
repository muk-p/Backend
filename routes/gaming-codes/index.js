const express = require('express');
const router = express.Router();

// Import separated route modules
router.use('/', require('./game-codes'));      // CRUD operations for gaming codes
router.use('/', require('./checkout'));        // Purchase/checkout operations

module.exports = router; 