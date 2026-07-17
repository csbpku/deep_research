\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (id, email, name, "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000001', 'preflight@example.com', 'Preflight', now());

DO $block$
BEGIN
    INSERT INTO content_import_jobs (
        "requesterId", "sourceKind", status, "contentSha256", "converterVersion"
    ) VALUES (
        '00000000-0000-4000-8000-000000000001', 'file', 'queued', repeat('a', 64), 'v1'
    );

    BEGIN
        INSERT INTO content_import_jobs (
            "requesterId", "sourceKind", status, "contentSha256", "converterVersion"
        ) VALUES (
            '00000000-0000-4000-8000-000000000001', 'file', 'running', repeat('a', 64), 'v1'
        );
        RAISE EXCEPTION 'active import dedupe did not fire';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    INSERT INTO content_import_jobs (
        "requesterId", "sourceKind", status, "contentSha256", "converterVersion"
    ) VALUES
        ('00000000-0000-4000-8000-000000000001', 'file', 'failed', repeat('b', 64), 'v1'),
        ('00000000-0000-4000-8000-000000000001', 'file', 'failed', repeat('b', 64), 'v1');

    BEGIN
        INSERT INTO ai_research_jobs (
            "requesterId", topic, status, "partialSources", "updatedAt"
        ) VALUES (
            '00000000-0000-4000-8000-000000000001', 'test', 'partial', '[1, 2]'::jsonb, now()
        );
        RAISE EXCEPTION 'partial source constraint did not fire';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
END
$block$;

ROLLBACK;

SELECT count(*) AS app_tables
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name <> '_prisma_migrations';
