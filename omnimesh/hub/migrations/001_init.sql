-- MVP slice of the schema in Omnimesh.md: nodes + generic jobs only.
-- incidents / ai_audit_logs (infra_remediation side) come later once
-- that job_type is actually built.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE nodes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    host_address VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'offline',
    capabilities TEXT[] NOT NULL DEFAULT '{}',
    hardware_metadata JSONB DEFAULT '{}'::jsonb,
    benchmark_tokens_per_sec NUMERIC(6, 2),
    benchmark_updated_at TIMESTAMP WITH TIME ZONE,
    last_seen_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_nodes_capabilities ON nodes USING GIN (capabilities);

CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_type VARCHAR(50) NOT NULL,
    required_capability VARCHAR(50) NOT NULL,
    priority SMALLINT NOT NULL DEFAULT 0,
    payload JSONB NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'queued',
    assigned_node_id UUID REFERENCES nodes(id) ON DELETE SET NULL,
    result JSONB,
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    assigned_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_jobs_queued ON jobs(status, required_capability, priority DESC) WHERE status = 'queued';
