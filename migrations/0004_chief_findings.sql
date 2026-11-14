-- The one GitHub issue comment that carries a task's investigation findings.
-- Only a digest of the findings is kept; the text lives on GitHub.
CREATE TABLE chief_findings (
  chief_id text NOT NULL,
  task_id text NOT NULL,
  digest text NOT NULL,
  sequence integer NOT NULL,
  findings_digest text NOT NULL,
  comment_id text,
  author_login text,
  comment_created_at timestamptz,
  posted_at timestamptz,
  PRIMARY KEY (chief_id, task_id),
  FOREIGN KEY (chief_id, task_id) REFERENCES chief_assignments(chief_id, task_id) ON DELETE RESTRICT
);
