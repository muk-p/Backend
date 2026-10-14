const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');

const authRoutes = require('./routes/auth');
const shoppingRoutes = require('./routes/shopping');
const gamingCodesRoutes = require('./routes/gaming-codes');
const auth = require('./middleware/auth');

const app = express();

// Trust reverse proxies (VS Code Dev Tunnels / Railway edge routing routers)
app.set('trust proxy', 1);

// Performance optimizations
app.use(compression());

// Security configuration headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Prevent proxy caching of authenticated security session data
app.use((req, res, next) => {
  if (req.path.includes('/api/auth')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

// Cross-Origin Resource Sharing pipeline guards
const allowedOrigins = new Set([
  'https://pixel-plays-iota.vercel.app',
  'https://web-portfolio-rouge-zeta.vercel.app',
  'https://www.pixelplays.co.ke',
  'https://pixelplays.co.ke',
  ...(process.env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
]);

app.use(cors({ 
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
  credentials: true 
}));

// Global parsing middleware layer configuration sizes
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// A valid demo token may read API data, but must not trigger state-changing requests.
app.use(auth.demoReadOnly);

// Cache static multi-part image uploads for 1 hour (3600 seconds)
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { 
  maxAge: '1h', 
  etag: false 
}));

// Application routing interface endpoints mapping assignments
app.use('/api/auth', authRoutes);
app.use('/api/shopping', shoppingRoutes);
app.use('/api/gaming-codes', gamingCodesRoutes);

// Server execution port runtime mapping
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
