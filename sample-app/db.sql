CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  inventory INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_items (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cart_session ON cart_items(session_id);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);

-- Only used when the app runs in FIXED mode.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO products (name, price_cents, inventory)
VALUES
  ('Wireless Mouse', 2499, 500),
  ('Mechanical Keyboard', 8999, 500),
  ('USB-C Hub', 3499, 500)
ON CONFLICT DO NOTHING;
