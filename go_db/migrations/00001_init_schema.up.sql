-- +goose Up
-- SQL in this section is executed when the migration is applied.

CREATE TYPE user_role AS ENUM ('user', 'fleet_manager', 'superadmin');

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT,
    email TEXT UNIQUE NOT NULL,
    email_verified TIMESTAMP WITH TIME ZONE,
    image TEXT,
    next_auth_id TEXT UNIQUE,
    stripe_customer_id TEXT,
    credits DECIMAL(10, 2) DEFAULT 0.00,
    role user_role NOT NULL DEFAULT 'user',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) NOT NULL,
    type TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_account_id TEXT NOT NULL,
    refresh_token TEXT,
    access_token TEXT,
    expires_at BIGINT,
    token_type TEXT,
    scope TEXT,
    id_token TEXT,
    session_state TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT unique_provider_account UNIQUE (provider, provider_account_id)
);

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) NOT NULL,
    session_token TEXT UNIQUE NOT NULL,
    expires TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE verification_tokens (
    identifier TEXT NOT NULL,
    token TEXT NOT NULL,
    expires TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (identifier, token)
);

CREATE TABLE board_types (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    dimensions TEXT
);

CREATE TABLE boards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_type_id INTEGER REFERENCES board_types(id),
    owner_id UUID REFERENCES users(id),
    device_id TEXT,
    approved BOOLEAN DEFAULT false,
    location TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT boards_approved_requires_board_type CHECK (
        (approved = false) OR (board_type_id IS NOT NULL)
    )
);

CREATE TABLE creative_groups (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    approved BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE creatives (
    id SERIAL PRIMARY KEY,
    creative_group_id INTEGER REFERENCES creative_groups(id),
    asset_link TEXT NOT NULL,
    type TEXT NOT NULL,
    approved BOOLEAN DEFAULT false,
    date_added TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE underlying_orders (
    id SERIAL PRIMARY KEY,
    priority INTEGER NOT NULL,
    service_area GEOGRAPHY(MULTIPOLYGON, 4326) NOT NULL,
    link_to_creative INTEGER REFERENCES creatives(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) NOT NULL,
    require_admin_approval BOOLEAN DEFAULT false,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE ad_with_priority (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    underlying_order_id INTEGER REFERENCES underlying_orders(id) NOT NULL,
    order_id UUID REFERENCES orders(id) NOT NULL,
    board_type_id INTEGER REFERENCES board_types(id) NOT NULL,
    ad_minutes INTEGER NOT NULL,
    time_of_week_range TEXT,
    service_area GEOGRAPHY(MULTIPOLYGON, 4326),
    completion_minutes INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 1 CHECK (priority IN (1, 2, 3)),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE vendor_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) NOT NULL,
    underlying_order_id INTEGER REFERENCES underlying_orders(id) NOT NULL,
    priority INTEGER NOT NULL,
    recurring BOOLEAN DEFAULT false,
    times_of_day TEXT,
    update_day_before INTEGER,
    location TEXT,
    max_boards INTEGER,
    board_ids TEXT[],
    require_admin_approval BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE minutes_available (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id UUID REFERENCES boards(id) NOT NULL,
    minutes_available INTEGER NOT NULL,
    time_of_day_range TEXT NOT NULL,
    service_area GEOGRAPHY(MULTIPOLYGON, 4326) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id) NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    reason TEXT,
    admin_user_id UUID REFERENCES users(id) NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID REFERENCES users(id) NOT NULL,
    referee_id UUID REFERENCES users(id),
    credits_awarded DECIMAL(10, 2) DEFAULT 0.00,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT unique_referral UNIQUE (referrer_id, referee_id)
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_accounts_user_id ON accounts(user_id);
CREATE INDEX idx_accounts_provider_account ON accounts(provider, provider_account_id);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(session_token);
CREATE INDEX idx_boards_device_id ON boards(device_id);
CREATE INDEX idx_boards_owner_id ON boards(owner_id);
CREATE INDEX idx_boards_approved ON boards(approved);
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_vendor_allocations_user_id ON vendor_allocations(user_id);
CREATE INDEX idx_minutes_available_board_id ON minutes_available(board_id);
CREATE INDEX idx_underlying_orders_service_area ON underlying_orders USING GIST (service_area);
CREATE INDEX idx_ad_with_priority_service_area ON ad_with_priority USING GIST (service_area);
CREATE INDEX idx_minutes_available_service_area ON minutes_available USING GIST (service_area);
CREATE INDEX idx_refunds_order_id ON refunds(order_id);
CREATE INDEX idx_refunds_admin_user_id ON refunds(admin_user_id);
CREATE INDEX idx_referrals_referrer_id ON referrals(referrer_id);
CREATE INDEX idx_referrals_referee_id ON referrals(referee_id);

-- +goose Down
-- SQL in this section is executed when the migration is rolled back.

DROP INDEX IF EXISTS idx_referrals_referee_id;
DROP INDEX IF EXISTS idx_referrals_referrer_id;
DROP INDEX IF EXISTS idx_refunds_admin_user_id;
DROP INDEX IF EXISTS idx_refunds_order_id;
DROP INDEX IF EXISTS idx_minutes_available_service_area;
DROP INDEX IF EXISTS idx_ad_with_priority_service_area;
DROP INDEX IF EXISTS idx_underlying_orders_service_area;
DROP INDEX IF EXISTS idx_minutes_available_board_id;
DROP INDEX IF EXISTS idx_vendor_allocations_user_id;
DROP INDEX IF EXISTS idx_orders_status;
DROP INDEX IF EXISTS idx_orders_user_id;
DROP INDEX IF EXISTS idx_boards_approved;
DROP INDEX IF EXISTS idx_boards_owner_id;
DROP INDEX IF EXISTS idx_boards_device_id;
DROP INDEX IF EXISTS idx_sessions_token;
DROP INDEX IF EXISTS idx_sessions_user_id;
DROP INDEX IF EXISTS idx_accounts_provider_account;
DROP INDEX IF EXISTS idx_accounts_user_id;
DROP INDEX IF EXISTS idx_users_role;
DROP INDEX IF EXISTS idx_users_email;

DROP TABLE IF EXISTS referrals CASCADE;
DROP TABLE IF EXISTS refunds CASCADE;
DROP TABLE IF EXISTS minutes_available CASCADE;
DROP TABLE IF EXISTS vendor_allocations CASCADE;
DROP TABLE IF EXISTS ad_with_priority CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS underlying_orders CASCADE;
DROP TABLE IF EXISTS creatives CASCADE;
DROP TABLE IF EXISTS creative_groups CASCADE;
DROP TABLE IF EXISTS boards CASCADE;
DROP TABLE IF EXISTS board_types CASCADE;
DROP TABLE IF EXISTS verification_tokens CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS accounts CASCADE;
DROP TABLE IF EXISTS users CASCADE;

DROP TYPE IF EXISTS user_role;
