const jwt = require('jsonwebtoken');

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
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

module.exports = auth;
