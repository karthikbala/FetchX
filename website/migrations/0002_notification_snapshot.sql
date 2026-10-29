ALTER TABLE enquiries ADD COLUMN notification_payload_json TEXT CHECK(notification_payload_json IS NULL OR json_valid(notification_payload_json));
