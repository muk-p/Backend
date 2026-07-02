CREATE DATABASE IF NOT EXISTS gadgetfinds;
USE gadgetfinds;

-- 1. MANAGERS (Admin Access Profile Accounts)
CREATE TABLE IF NOT EXISTS managers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. BUYERS (Store Customers Account Logins)
CREATE TABLE IF NOT EXISTS buyers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. PHYSICAL PRODUCTS (Hardware Assets Stock Catalog)
CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  brand VARCHAR(100),
  category VARCHAR(100), 
  price DECIMAL(10,2) NOT NULL,
  old_price DECIMAL(10,2),
  stock INT DEFAULT 0,
  image_url TEXT,
  description TEXT,
  features JSON,          
  specs JSON,             
  is_hero BOOLEAN DEFAULT FALSE, 
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 4. DIGITAL PRODUCTS (Master Definitions for Game Codes/UC/Diamonds)
CREATE TABLE IF NOT EXISTS gaming_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(255) NULL,
  name VARCHAR(200) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  region VARCHAR(50) DEFAULT 'Global',
  platform VARCHAR(50) DEFAULT 'Mobile',
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_gaming_codes_slug ON gaming_codes(slug);

-- 5. INDIVIDUAL GAMING CODES INVENTORY (The actual keys sold to users)
CREATE TABLE IF NOT EXISTS gaming_code_inventory (
  id INT AUTO_INCREMENT PRIMARY KEY,
  gaming_code_id INT NOT NULL,
  code VARCHAR(255) NOT NULL UNIQUE,
  status ENUM('available', 'sold', 'reserved') DEFAULT 'available',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  sold_at TIMESTAMP NULL,
  buyer_id INT NULL,
  FOREIGN KEY (gaming_code_id) REFERENCES gaming_codes(id) ON DELETE CASCADE,
  FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE SET NULL
);

-- 6. PHYSICAL HARDWARE ORDERS (Master Invoice Receipt Tracker)
CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  buyer_id INT NOT NULL, 
  address TEXT NOT NULL,
  payment_method VARCHAR(100) NOT NULL,
  total_amount DECIMAL(10,2) NOT NULL,
  status ENUM('pending', 'processing', 'shipped', 'delivered', 'canceled') DEFAULT 'pending',
  merchant_request_id VARCHAR(100) NULL UNIQUE, -- Added to link physical checkouts to Safaricom
  order_number VARCHAR(30) NULL UNIQUE, -- Added to give each order a random alphanumeric reference
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- Added for dashboard timeline graphs
  FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE
);

-- 7. PHYSICAL ORDER LINE ITEMS (Granular Cart Products Storage)
CREATE TABLE IF NOT EXISTS order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  price_at_purchase DECIMAL(10,2) NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
);

-- 8. DIGITAL CODE PURCHASES LOG (API Webhook tracking for payments)
CREATE TABLE IF NOT EXISTS gaming_code_purchases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  buyer_id INT NOT NULL,
  gaming_code_id INT NOT NULL,               
  inventory_id INT NULL,                      
  purchase_price DECIMAL(10,2) NOT NULL,
  mpesa_phone VARCHAR(20) NOT NULL,
  merchant_request_id VARCHAR(100) NOT NULL UNIQUE, 
  status ENUM('pending', 'completed', 'failed', 'refund_required') DEFAULT 'pending',
  purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE,
  FOREIGN KEY (gaming_code_id) REFERENCES gaming_codes(id) ON DELETE CASCADE,
  FOREIGN KEY (inventory_id) REFERENCES gaming_code_inventory(id) ON DELETE RESTRICT
);

-- Optimization Indexes for high-speed dashboard analytics calculations
CREATE INDEX idx_purchases_merchant_id ON gaming_code_purchases(merchant_request_id);
CREATE INDEX idx_orders_merchant_id ON orders(merchant_request_id);
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_hero ON products(is_hero);
CREATE INDEX idx_products_created_at ON products(created_at);
CREATE INDEX idx_gaming_codes_platform ON gaming_codes(platform);
CREATE INDEX idx_gaming_code_inventory_status ON gaming_code_inventory(status);
CREATE INDEX idx_orders_buyer_id ON orders(buyer_id);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_buyers_email ON buyers(email);
CREATE INDEX idx_managers_email ON managers(email);
