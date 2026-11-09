-- GTM-agents: the copy a template experiment started with.
--
-- An experiment's start binds to the exact copy the operator was shown: the SHA-256 of both
-- template files is recorded when it starts. While either template's current file differs, the
-- experiment enrolls no one and cannot conclude (packages/core/src/experiments/cycle.ts), because
-- it would otherwise be judged on copy nobody approved.

-- once: SQLite cannot guard ADD COLUMN; the migration runner applies this file exactly once.
ALTER TABLE experiments ADD COLUMN control_template_sha256 TEXT CHECK (control_template_sha256 IS NULL OR (length(control_template_sha256) = 64 AND control_template_sha256 NOT GLOB '*[^0-9a-f]*'));
-- once: as above.
ALTER TABLE experiments ADD COLUMN treatment_template_sha256 TEXT CHECK (treatment_template_sha256 IS NULL OR (length(treatment_template_sha256) = 64 AND treatment_template_sha256 NOT GLOB '*[^0-9a-f]*'));
