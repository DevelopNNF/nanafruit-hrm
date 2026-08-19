-- Fingerprint scanner ID (รหัสลายนิ้วมือ). The identifier a biometric
-- terminal knows an employee by, which is deliberately NOT employee_code: the
-- terminals were enrolled independently of this system and their numbering
-- does not line up with HR's. This column is the only thing that can tie a
-- scanner's exported attendance sheet back to an employees row, so the
-- attendance import keys on it.
--
-- Nullable: only staff who actually clock at a terminal have one, and most
-- clock in through LINE instead. An empty value here means "not applicable",
-- not "missing" — same reasoning as 013's gender and 027's id_card_number.
--
-- Unique because it is the import's lookup key: two employees sharing a code
-- would make a scanner row ambiguous, and there is no safe way to guess which
-- of them a punch belongs to. As with id_card_number, multiple NULLs are
-- still allowed — Postgres treats NULL as distinct from itself in a UNIQUE
-- constraint.
--
-- text rather than an integer, and length-capped rather than digit-checked:
-- the codes in the current export happen to be four digits, but terminal
-- vendors also issue alphanumeric ones, and a leading zero has to survive the
-- round trip. '' is rejected outright so it can never sit here as a second
-- "blank" value competing with NULL — the API trims and empties to NULL, and
-- this CHECK is what keeps that true no matter who writes the row.

ALTER TABLE employees
  ADD COLUMN fingerprint_code text
    CHECK (fingerprint_code <> '' AND length(fingerprint_code) <= 20),
  ADD CONSTRAINT employees_fingerprint_code_key UNIQUE (fingerprint_code);
