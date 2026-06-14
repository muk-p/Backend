# GadgetFinds Backend

Backend starter project for the gaming gadgets store.

## Setup

1. Copy `.env.example` to `.env` and fill in your values.
2. Install dependencies:
   ```bash
   cd backend
   npm install
   ```
3. Create the MySQL database and tables using the init script:
   ```bash
   npm run init-db
   ```
4. Start the server:
   ```bash
   npm run dev
   ```

## Available APIs

### Shopping
- `POST /api/auth/register` - create a new administrator account
- `POST /api/auth/login` - administrator login
- `POST /api/auth/buyer/register` - create a new buyer account
- `POST /api/auth/buyer/login` - buyer login
- `GET /api/products` - list products (each product may include `image_url`)
- `GET /api/products/:id` - product details (includes `image_url`)
- `POST /api/products` - create product (administrator auth required)
- `PUT /api/products/:id` - update product (administrator auth required)
- `DELETE /api/products/:id` - delete product (administrator auth required)
- `POST /api/products/import-pdf` - import products from PDF file (administrator auth required)

  **PDF Format Requirements:**
  - Upload a PDF file containing product information
  - Expected format: Product name on separate lines, followed by price and description
  - Example PDF content:
    ```
    Gaming Mouse
    $49.99
    High-precision optical gaming mouse with programmable buttons

    Mechanical Keyboard
    $89.99
    Tactile mechanical keyboard with RGB lighting
    ```
  - Parser looks for: Product names (capitalized lines), prices ($XX.XX format), descriptions
  - **Note:** The PDF parser uses basic text extraction. For best results, ensure your PDF contains clean, structured text. You may need to adjust the parsing logic in `server.js` based on your specific PDF format.
- `POST /api/order` - create an order and send email (public checkout)
- `POST /api/payment` - mock payment endpoint (public checkout)
- `GET /api/checkout/:orderId` - retrieve checkout/order details
- `GET /api/orders` - list all orders (administrator auth required)
- `GET /api/order/:id` - retrieve specific order details

### Gaming Codes
- `GET /api/gaming-codes` - list gaming codes
- `GET /api/gaming-codes/:id` - gaming code details
- `POST /api/gaming-codes` - create gaming code (administrator auth required)
- `PUT /api/gaming-codes/:id` - update gaming code (administrator auth required)
- `DELETE /api/gaming-codes/:id` - delete gaming code (administrator auth required)
- `POST /api/gaming-codes/purchase/:id` - purchase gaming code (buyer auth required, code sent to email)

## Notes

- Use `JWT_SECRET` for auth token signing.
- Use `ORDER_EMAIL` for new order notifications.
- Managers are administrators with full access to manage products, orders, and gaming codes.
- Buyers can register and login to access personalized features.

