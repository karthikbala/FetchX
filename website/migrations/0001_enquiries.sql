CREATE TABLE enquiries (
 reference TEXT PRIMARY KEY,
 request_id TEXT NOT NULL UNIQUE,
 dedupe_key TEXT NOT NULL UNIQUE,
 payload_hash TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 privacy_version TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 notification_status TEXT NOT NULL DEFAULT 'pending' CHECK(notification_status IN ('pending','sending','sent','failed','uncertain')),
 notification_attempts INTEGER NOT NULL DEFAULT 0,
 notification_first_attempt_at INTEGER,
 notification_last_attempt_at INTEGER,
 notification_lease TEXT,
 notification_id TEXT,
 notification_error TEXT
);
CREATE INDEX enquiries_expiry ON enquiries(expires_at);
CREATE INDEX enquiries_notifications ON enquiries(notification_status, notification_last_attempt_at);
CREATE TABLE rate_buckets (
 bucket_key TEXT PRIMARY KEY,
 attempts INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX rate_buckets_expiry ON rate_buckets(expires_at);
