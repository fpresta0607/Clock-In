WITH organizations_without_admin AS (
  SELECT organizations.id
  FROM organizations
  WHERE NOT EXISTS (
    SELECT 1
    FROM users
    WHERE users.organization_id = organizations.id
      AND users.role = 'admin'
  )
), ranked_members AS (
  SELECT users.id,
         row_number() OVER (PARTITION BY users.organization_id ORDER BY users.created_at, users.id) AS rank
  FROM users
  INNER JOIN organizations_without_admin
    ON organizations_without_admin.id = users.organization_id
)
UPDATE users
SET role = 'admin'
FROM ranked_members
WHERE users.id = ranked_members.id
  AND ranked_members.rank = 1;
--> statement-breakpoint
INSERT INTO projects (organization_id, name, is_default)
SELECT organizations.id, 'General Work', true
FROM organizations
WHERE NOT EXISTS (
  SELECT 1
  FROM projects
  WHERE projects.organization_id = organizations.id
    AND projects.is_default
    AND NOT projects.archived
)
ON CONFLICT (organization_id) WHERE is_default DO NOTHING;
--> statement-breakpoint
INSERT INTO project_memberships (organization_id, project_id, user_id)
SELECT projects.organization_id, projects.id, users.id
FROM projects
INNER JOIN users
  ON users.organization_id = projects.organization_id
WHERE projects.is_default
  AND NOT projects.archived
ON CONFLICT (organization_id, user_id, project_id) DO NOTHING;
