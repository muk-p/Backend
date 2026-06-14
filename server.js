const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const compression = require('compression');
const authRoutes = require('./routes/auth');
const shoppingRoutes = require('./routes/shopping');
const gamingCodesRoutes = require('./routes/gaming-codes');
const pool = require('./db');
const auth = require('./middleware/auth');
const helmet = require('helmet');

const app = express();

// Trust the VS Code Dev Tunnel reverse proxy to fix validation errors
app.set('trust proxy', 1);

// Performance optimizations
app.use(compression());

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Prevent caching of sensitive data
app.use((req, res, next) => {
  if (req.path.includes('/api/auth')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

app.use(cors({ 
  origin: process.env.CORS_ORIGIN || 'https://pixel-plays-iota.vercel.app', 
  credentials: true 
}));
app.use(express.json({ limit: '10mb' }));

// Cache static assets for 1 hour (3600 seconds)
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { 
  maxAge: '1h', 
  etag: false 
}));

app.use('/api/auth', authRoutes);
app.use('/api/shopping', shoppingRoutes);
app.use('/api/gaming-codes', gamingCodesRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
