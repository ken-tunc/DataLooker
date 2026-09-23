-- A small shop to point DataLooker at: `docker compose --profile demo up -d
-- --wait demo`, then add a connection to localhost:55433, database `demo`, user
-- and password `demo`. The rows are generated from a fixed seed, so every
-- container holds the same ones.
--
-- Each thing here is here to show something: enough rows to page through,
-- every kind of relation the tree draws, the types a grid has to render, a
-- table with no primary key (read-only), and a run of date-named tables that
-- the tree folds into one row.

SELECT setseed(0.42);

CREATE SCHEMA shop;
CREATE SCHEMA analytics;

CREATE TYPE shop.order_status AS ENUM ('pending', 'paid', 'shipped', 'delivered', 'cancelled');

CREATE TABLE shop.customers (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email       text NOT NULL UNIQUE,
    name        text NOT NULL,
    country     char(2) NOT NULL,
    tags        text[] NOT NULL DEFAULT '{}',
    preferences jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop.products (
    id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sku         uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    price       numeric(10, 2) NOT NULL CHECK (price >= 0),
    stock       integer NOT NULL DEFAULT 0,
    discontinued boolean NOT NULL DEFAULT false,
    description text
);

CREATE TABLE shop.orders (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id bigint NOT NULL REFERENCES shop.customers (id) ON DELETE CASCADE,
    status      shop.order_status NOT NULL DEFAULT 'pending',
    ordered_at  timestamptz NOT NULL,
    shipped_on  date,
    note        text
);
CREATE INDEX orders_by_customer ON shop.orders (customer_id, ordered_at DESC);
CREATE INDEX orders_pending ON shop.orders (ordered_at) WHERE status = 'pending';

CREATE TABLE shop.order_items (
    order_id   bigint NOT NULL REFERENCES shop.orders (id) ON DELETE CASCADE,
    product_id integer NOT NULL REFERENCES shop.products (id),
    quantity   smallint NOT NULL CHECK (quantity > 0),
    unit_price numeric(10, 2) NOT NULL,
    PRIMARY KEY (order_id, product_id)
);

CREATE FUNCTION shop.touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END
$$;
CREATE TRIGGER customers_touched BEFORE UPDATE ON shop.customers
    FOR EACH ROW EXECUTE FUNCTION shop.touch();

-- `setseed` governs `random()` and nothing else, so what a default would take
-- from the clock or from `gen_random_uuid()` is given here instead.
INSERT INTO shop.customers (email, name, country, tags, preferences, created_at, updated_at)
SELECT
    format('customer%s@example.com', n),
    (ARRAY['Ada', 'Grace', 'Edsger', 'Barbara', 'Donald', 'Frances', 'Ken', 'Radia',
           '花子', '太郎', 'Zoë', 'José'])[1 + n % 12]
        || ' ' || (ARRAY['Lovelace', 'Hopper', 'Dijkstra', 'Liskov', 'Knuth', 'Allen',
                         'Thompson', 'Perlman', '山田', '佐藤'])[1 + n % 10],
    (ARRAY['JP', 'US', 'GB', 'DE', 'FR', 'BR', 'IN'])[1 + n % 7],
    CASE WHEN n % 5 = 0 THEN ARRAY['vip'] WHEN n % 3 = 0 THEN ARRAY['newsletter', 'beta'] ELSE '{}' END,
    jsonb_build_object('theme', CASE WHEN n % 2 = 0 THEN 'dark' ELSE 'light' END,
                       'language', (ARRAY['ja', 'en', 'de'])[1 + n % 3],
                       'notifications', n % 4 <> 0),
    timestamptz '2024-01-01 00:00:00+00' + (n * interval '7 hours'),
    timestamptz '2024-01-01 00:00:00+00' + (n * interval '7 hours')
FROM generate_series(1, 1200) AS n;

INSERT INTO shop.products (sku, name, price, stock, discontinued, description)
SELECT
    md5('product-' || n)::uuid,
    initcap((ARRAY['walnut', 'steel', 'linen', 'ceramic', 'glass', 'oak'])[1 + n % 6])
        || ' ' || (ARRAY['mug', 'lamp', 'chair', 'notebook', 'bowl', 'shelf', 'clock', 'vase'])[1 + n % 8]
        || ' No. ' || n,
    round((5 + random() * 495)::numeric, 2),
    (random() * 200)::int,
    n % 17 = 0,
    CASE WHEN n % 4 = 0 THEN NULL ELSE 'A demo product, number ' || n || '.' END
FROM generate_series(1, 80) AS n;

INSERT INTO shop.orders (customer_id, status, ordered_at, shipped_on, note)
SELECT
    1 + (random() * 1199)::int,
    s.status,
    s.at,
    CASE WHEN s.status IN ('shipped', 'delivered') THEN (s.at + interval '2 days')::date END,
    CASE WHEN n % 11 = 0 THEN 'Gift wrap, please.' END
FROM generate_series(1, 8000) AS n,
LATERAL (
    SELECT
        (ARRAY['pending', 'paid', 'shipped', 'delivered', 'delivered', 'delivered', 'cancelled'])
            [1 + (random() * 6)::int]::shop.order_status AS status,
        timestamptz '2025-01-01 00:00:00+00' + random() * interval '600 days' AS at
    WHERE n > 0
) AS s;

INSERT INTO shop.order_items (order_id, product_id, quantity, unit_price)
SELECT DISTINCT ON (o.id, p.product_id)
    o.id, p.product_id, 1 + (random() * 3)::int, pr.price
FROM shop.orders AS o
CROSS JOIN LATERAL (
    SELECT 1 + (random() * 79)::int AS product_id
    FROM generate_series(1, 1 + (o.id % 4)::int)
    WHERE o.id > 0
) AS p
JOIN shop.products AS pr ON pr.id = p.product_id;

CREATE VIEW shop.order_totals AS
SELECT o.id AS order_id, o.customer_id, o.status, o.ordered_at,
       sum(i.quantity * i.unit_price) AS total
FROM shop.orders AS o
JOIN shop.order_items AS i ON i.order_id = o.id
GROUP BY o.id;

CREATE MATERIALIZED VIEW analytics.monthly_revenue AS
SELECT date_trunc('month', ordered_at)::date AS month,
       count(*) AS orders,
       sum(total) AS revenue
FROM shop.order_totals
WHERE status <> 'cancelled'
GROUP BY 1
ORDER BY 1;

-- No primary key, so nothing can name a row of it: DataLooker reads it and
-- does not offer to edit it.
CREATE TABLE analytics.page_views (
    viewed_at  timestamptz NOT NULL,
    path       text NOT NULL,
    visitor    inet,
    duration   interval,
    bytes_sent bigint
);
INSERT INTO analytics.page_views
SELECT
    timestamptz '2025-06-01 00:00:00+00' + n * interval '37 seconds',
    (ARRAY['/', '/products', '/cart', '/checkout', '/account'])[1 + n % 5],
    ('10.0.' || n % 256 || '.' || (n * 7) % 256)::inet,
    make_interval(secs => (random() * 300)::int),
    -- Past what a JavaScript number holds, now and then.
    CASE WHEN n % 250 = 0 THEN 9007199254740993 + n ELSE (random() * 100000)::bigint END
FROM generate_series(1, 3000) AS n;

-- A table written a day at a time, which the tree folds into one row.
DO $$
DECLARE
    day date;
BEGIN
    FOR day IN SELECT generate_series(date '2025-01-01', date '2025-01-14', interval '1 day')::date LOOP
        EXECUTE format(
            'CREATE TABLE analytics.%I (id bigint PRIMARY KEY, kind text NOT NULL, payload jsonb)',
            'events_' || to_char(day, 'YYYYMMDD'));
        EXECUTE format(
            'INSERT INTO analytics.%I SELECT n, (ARRAY[''click'', ''view'', ''purchase''])[1 + n %% 3], '
            'jsonb_build_object(''n'', n) FROM generate_series(1, 50) AS n',
            'events_' || to_char(day, 'YYYYMMDD'));
    END LOOP;
END
$$;

-- A table split by range, which its structure shows as partitions.
CREATE TABLE analytics.sessions (
    id         bigint NOT NULL,
    started_at timestamptz NOT NULL,
    customer_id bigint,
    PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);
CREATE TABLE analytics.sessions_2025 PARTITION OF analytics.sessions
    FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE analytics.sessions_2026 PARTITION OF analytics.sessions
    FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
INSERT INTO analytics.sessions
SELECT n, timestamptz '2025-01-01 00:00:00+00' + random() * interval '600 days',
       1 + (random() * 1199)::int
FROM generate_series(1, 2000) AS n;

ANALYZE;
