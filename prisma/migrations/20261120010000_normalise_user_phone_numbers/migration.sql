-- User.phoneNumber in E.164 (P1-G.2, USR-05): the API now accepts only Ghana numbers and stores +233 and nine
-- digits, so existing values are rewritten the same way (src/commons/phone/ghana-phone.ts is the reference).
-- Blank values become NULL. If any value is not a Ghana number, or two users would end up with the same number,
-- nothing is changed and the migration fails with counts only (never the numbers) for someone to resolve by hand.
-- Safe to re-run: normalised values map to themselves.

UPDATE "User" SET "phoneNumber" = NULL WHERE btrim("phoneNumber") = '';

DO $$
DECLARE
  unparseable integer;
  shared integer;
BEGIN
  CREATE TEMP TABLE normalised_phone ON COMMIT DROP AS
  SELECT id,
         CASE
           WHEN cleaned ~ '^(0|233|\+233|00233)[1-9][0-9]{8}$' THEN '+233' || right(cleaned, 9)
         END AS e164
  FROM (
    SELECT id, regexp_replace("phoneNumber", '[[:space:].()-]', '', 'g') AS cleaned
    FROM "User"
    WHERE "phoneNumber" IS NOT NULL
  ) AS raw;

  SELECT count(*) INTO unparseable FROM normalised_phone WHERE e164 IS NULL;
  SELECT count(*) INTO shared
  FROM (SELECT e164 FROM normalised_phone WHERE e164 IS NOT NULL GROUP BY e164 HAVING count(*) > 1) AS dup;

  IF unparseable > 0 OR shared > 0 THEN
    RAISE EXCEPTION 'User.phoneNumber normalisation stopped: % value(s) are not Ghana phone numbers and % number(s) would be shared by more than one user. Fix those users by hand, then re-run.',
      unparseable, shared;
  END IF;

  UPDATE "User" AS u
  SET "phoneNumber" = n.e164
  FROM normalised_phone AS n
  WHERE u.id = n.id AND u."phoneNumber" <> n.e164;
END $$;
