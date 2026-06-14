const express = require('express');
const router = express.Router();
const pool = require('../../db');
const auth = require('../../middleware/auth');

router.get('/', auth, async (req, res) => {
  if (req.user?.role !== 'manager') {
    return res.status(403).json({ message: 'Managers only' });
  }

  try {
    const [summaryRows] = await pool.query(`
      SELECT
        COUNT(*) AS total_orders,
        COALESCE(SUM(CASE WHEN status != 'canceled' THEN total_amount ELSE 0 END), 0) AS total_revenue,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_orders,
        COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) AS processing_orders,
        COALESCE(SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END), 0) AS shipped_orders,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered_orders,
        COALESCE(SUM(CASE WHEN status IN ('processing', 'shipped', 'delivered') THEN 1 ELSE 0 END), 0) AS completed_orders,
        COALESCE(SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END), 0) AS canceled_orders,
        COALESCE(AVG(CASE WHEN status != 'canceled' THEN total_amount END), 0) AS average_order_value
      FROM orders
    `);

    const [productRows] = await pool.query(`
      SELECT
        COUNT(*) AS total_products,
        COALESCE(SUM(CASE WHEN stock <= 5 AND stock > 0 THEN 1 ELSE 0 END), 0) AS low_stock_products,
        COALESCE(SUM(CASE WHEN stock = 0 THEN 1 ELSE 0 END), 0) AS out_of_stock_products,
        COALESCE(SUM(CASE WHEN is_hero = 1 THEN 1 ELSE 0 END), 0) AS featured_products
      FROM products
    `);

    const [topProductRows] = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.category,
        SUM(oi.quantity) AS sales,
        SUM(oi.quantity * oi.price_at_purchase) AS revenue
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status != 'canceled'
      GROUP BY p.id, p.name, p.category
      ORDER BY sales DESC, revenue DESC
      LIMIT 3
    `);

    const [recentOrderRows] = await pool.query(`
      SELECT
        o.id,
        o.order_number,
        o.total_amount,
        o.status,
        o.created_at,
        b.name AS customer_name
      FROM orders o
      LEFT JOIN buyers b ON b.id = o.buyer_id
      ORDER BY o.created_at DESC
      LIMIT 8
    `);

    const summary = summaryRows[0] || {};
    const products = productRows[0] || {};

    res.json({
      summary: {
        totalRevenue: Number(summary.total_revenue || 0),
        totalOrders: Number(summary.total_orders || 0),
        pendingOrders: Number(summary.pending_orders || 0),
        processingOrders: Number(summary.processing_orders || 0),
        shippedOrders: Number(summary.shipped_orders || 0),
        deliveredOrders: Number(summary.delivered_orders || 0),
        completedOrders: Number(summary.completed_orders || 0),
        canceledOrders: Number(summary.canceled_orders || 0),
        averageOrderValue: Number(summary.average_order_value || 0),
        totalProducts: Number(products.total_products || 0),
        lowStockProducts: Number(products.low_stock_products || 0),
        outOfStockProducts: Number(products.out_of_stock_products || 0),
        featuredProducts: Number(products.featured_products || 0),
      },
      topProducts: topProductRows.map((item) => ({
        ...item,
        sales: Number(item.sales || 0),
        revenue: Number(item.revenue || 0),
      })),
      recentOrders: recentOrderRows.map((order) => ({
        id: order.id,
        orderNumber: order.order_number,
        customerName: order.customer_name || 'Guest',
        totalAmount: Number(order.total_amount || 0),
        status: order.status,
        createdAt: order.created_at,
      })),
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ message: 'Failed to load manager stats' });
  }
});

module.exports = router;
