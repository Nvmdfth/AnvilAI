-- Per-node tunable config (hammer generation params, scheduler weight)
-- and live resource metrics reported on each poll.
ALTER TABLE nodes ADD COLUMN config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE nodes ADD COLUMN latest_metrics JSONB;
ALTER TABLE nodes ADD COLUMN metrics_updated_at TIMESTAMP WITH TIME ZONE;
