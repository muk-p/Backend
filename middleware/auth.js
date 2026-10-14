const jwt = require('jsonwebtoken');

const stateChangingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function demoReadOnly(req, res, next) {
  const authorization = req.headers.authorization || req.headers.Authorization;
  if (!authorization || typeof authorization !== 'string') {
    return next();
  }

  const token = authorization.replace(/^Bearer\s+/i, '');
  if (!token) {
    return next();
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.isDemo === true && stateChangingMethods.has(req.method)) {
      return res.status(403).json({ message: 'Demo mode: modifications disabled' });
    }
  } catch (error) {
    // Public endpoints retain their existing behavior; protected endpoints validate tokens in auth().
  }

  next();
}

function auth(req, res, next) {
  const authorization = req.headers.authorization || req.headers.Authorization;
  if (!authorization || typeof authorization !== 'string') {
    return res.status(401).json({ message: 'Authorization header is required' });
  }

  const token = authorization.replace(/^Bearer\s+/i, '');
  if (!token) {
    return res.status(401).json({ message: 'Bearer token is required' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.isDemo === true && stateChangingMethods.has(req.method)) {
      return res.status(403).json({ message: 'Demo mode: modifications disabled' });
    }

    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

auth.demoReadOnly = demoReadOnly;

module.exports = auth;
