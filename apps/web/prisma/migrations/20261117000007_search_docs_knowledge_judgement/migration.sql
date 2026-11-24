CREATE OR REPLACE FUNCTION sync_search_docs_from_research() RETURNS trigger AS $$
DECLARE
  v_title text;
  v_snippet text;
  v_published_at timestamptz;
  v_doc_type "SearchDocType";
  v_should_index boolean;
BEGIN
  v_should_index := (NEW.status = 'published' AND NEW."publishedAt" IS NOT NULL);

  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_docs
      WHERE "refId" = OLD.id
        AND ((OLD.type = 'research' AND type = 'long_research')
          OR (OLD.type = 'knowledge' AND type = 'knowledge'));
    RETURN OLD;
  END IF;

  IF NOT v_should_index THEN
    DELETE FROM search_docs
      WHERE "refId" = NEW.id
        AND ((NEW.type = 'research' AND type = 'long_research')
          OR (NEW.type = 'knowledge' AND type = 'knowledge'));
    RETURN NEW;
  END IF;

  IF NEW.type = 'research' THEN
    v_doc_type := 'long_research';
  ELSE
    v_doc_type := 'knowledge';
  END IF;

  v_title := NEW.title;
  v_snippet := left(
    regexp_replace(
      coalesce(NEW.judgement, '') || E'\n'
        || coalesce(NEW."judgementScope", '') || E'\n'
        || coalesce(NEW.background, '') || E'\n'
        || coalesce(NEW.body, ''),
      E'<[^>]+>|[-*#>_\[\]]+|\x60+', ' ', 'g'
    ),
    1000
  );
  v_published_at := NEW."publishedAt";

  INSERT INTO search_docs (id, type, "refId", title, snippet, "publishedAt", "indexedAt", doc_tsv)
  VALUES (
    gen_random_uuid(),
    v_doc_type,
    NEW.id,
    v_title,
    v_snippet,
    v_published_at,
    now(),
    setweight(to_tsvector('simple', coalesce(v_title, '')), 'A')
      || setweight(to_tsvector('simple', coalesce(v_snippet, '')), 'B')
  )
  ON CONFLICT (type, "refId") DO UPDATE SET
    title = EXCLUDED.title,
    snippet = EXCLUDED.snippet,
    "publishedAt" = EXCLUDED."publishedAt",
    "indexedAt" = now(),
    doc_tsv = EXCLUDED.doc_tsv;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
