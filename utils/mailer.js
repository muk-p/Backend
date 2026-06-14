const nodemailer = require('nodemailer');

// Simple HTML escape function to prevent XSS
function escapeHtml(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: Number(process.env.MAIL_PORT || 587),
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

async function sendOrderEmail(order) {
  const adminEmail = process.env.ORDER_EMAIL;
  if (!adminEmail) {
    throw new Error('ORDER_EMAIL is not configured');
  }

  const itemsHtml = order.items
    .map(item => {
      const price = Number(item.price ?? item.unitPrice ?? item.unit_price ?? 0);
      const quantity = Number(item.quantity ?? 0);
      const name = escapeHtml(item.name || item.productId || 'Unknown product');
      return `<li>${quantity} × ${name} @ $${Number.isFinite(price) ? price.toFixed(2) : '0.00'}</li>`;
    })
    .join('');

  const totalAmount = Number(order.totalAmount ?? 0);
  const html = `
    <h2>New Gadget Find Order #${order.orderId}</h2>
    <p><strong>Customer:</strong> ${escapeHtml(order.customerName)}</p>
    <p><strong>Email:</strong> ${escapeHtml(order.customerEmail)}</p>
    <p><strong>Address:</strong> ${escapeHtml(order.address)}</p>
    <p><strong>Payment:</strong> ${escapeHtml(order.paymentMethod)}</p>
    <p><strong>Total:</strong> $${Number.isFinite(totalAmount) ? totalAmount.toFixed(2) : '0.00'}</p>
    <h3>Items</h3>
    <ul>${itemsHtml}</ul>
  `;

  await transporter.sendMail({
    from: process.env.MAIL_USER,
    to: adminEmail,
    subject: `New gadget order #${order.orderId}`,
    html
  });
}

async function sendGamingCodeEmail(purchase) {
  const html = `
    <h2>Thank you for your purchase!</h2>
    <p><strong>Game:</strong> ${purchase.gameName}</p>
    <p><strong>Code:</strong> ${purchase.code}</p>
    <p><strong>Price:</strong> $${Number(purchase.price).toFixed(2)}</p>
    <p><strong>Purchased on:</strong> ${new Date(purchase.purchasedAt).toLocaleString()}</p>
    <p>Please redeem this code in your game. If you have any issues, contact support.</p>
  `;

  await transporter.sendMail({
    from: process.env.MAIL_USER,
    to: purchase.buyerEmail,
    subject: `Your Gaming Code for ${purchase.gameName}`,
    html
  });
}

module.exports = { sendOrderEmail, sendGamingCodeEmail };
