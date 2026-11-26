-- A comparable fingerprint of a database (P9-D): per table its row count and a checksum of its rows, then every
-- trigger, constraint, index, function, sequence position and extension, one line each in a stable order. Run it on
-- the source and on the restored copy and diff the output: any line that differs is something the restore lost or
-- changed. Read-only. The checksums read every row, so on a large production database run it on a quiet replica or
-- with -v checksums=false (counts and schema only).
--
--   psql "$DATABASE_URL" -X -At -v checksums=true -f scripts/dr/fingerprint.sql > fingerprint.txt
\set ON_ERROR_STOP on
\if :{?checksums}
\else
\set checksums true
\endif
CREATE FUNCTION pg_temp.table_fingerprints(with_checksums boolean) RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE
  t record;
  line text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname
  LOOP
    IF with_checksums THEN
      EXECUTE format(
        'SELECT %L || ''|rows='' || count(*) || ''|md5='' || COALESCE(md5(string_agg(x::text, E''\n'' ORDER BY x::text)), ''-'') FROM %I x',
        t.relname, t.relname) INTO line;
    ELSE
      EXECUTE format('SELECT %L || ''|rows='' || count(*) FROM %I', t.relname, t.relname) INTO line;
    END IF;
    RETURN NEXT 'table|' || line;
  END LOOP;
END $$;

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT line FROM (
  SELECT pg_temp.table_fingerprints(:'checksums'::boolean) AS line
  UNION ALL
  SELECT 'trigger|' || c.relname || '|' || tg.tgname || '|enabled=' || tg.tgenabled::text || '|' || pg_get_triggerdef(tg.oid)
  FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT tg.tgisinternal
  UNION ALL
  -- CHECK texts are compared without brackets: a restore re-parses `(a AND b) AND c` (e.g. from BETWEEN) as
  -- `a AND b AND c`, the same constraint printed with fewer brackets.
  SELECT 'constraint|' || c.relname || '|' || co.conname || '|validated=' || co.convalidated || '|'
         || CASE WHEN co.contype = 'c' THEN regexp_replace(pg_get_constraintdef(co.oid), '[()]', '', 'g')
                 ELSE pg_get_constraintdef(co.oid) END
  FROM pg_constraint co JOIN pg_class c ON c.oid = co.conrelid JOIN pg_namespace n ON n.oid = co.connamespace
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'index|' || tablename || '|' || indexname || '|' || indexdef FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL
  SELECT 'function|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|md5=' || md5(pg_get_functiondef(p.oid))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'sequence|' || sequencename || '|last_value=' || COALESCE(last_value::text, 'unset') FROM pg_sequences
  WHERE schemaname = 'public'
  UNION ALL
  SELECT 'enum|' || t.typname || '|' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
  FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' GROUP BY t.typname
  UNION ALL
  SELECT 'extension|' || extname || '|' || extversion FROM pg_extension
) lines
ORDER BY line;

ROLLBACK;
