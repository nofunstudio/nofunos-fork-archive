import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Frozen migration 63. Future projection changes require a new migration.
const ddl = `
CREATE TABLE projection_mission_planning (
  planning_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  authority_environment_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  record_revision INTEGER NOT NULL,
  stage TEXT NOT NULL,
  record_json TEXT NOT NULL,
  gui_lease TEXT NOT NULL CHECK (gui_lease IN ('held', 'released')),
  lease_manager_thread_id TEXT,
  lease_manager_epoch INTEGER,
  mission_revision_at_write INTEGER NOT NULL,
  reservation_persisted_at_ms INTEGER NOT NULL,
  reservation_manager_thread_id TEXT NOT NULL,
  reservation_manager_epoch INTEGER NOT NULL,
  reservation_record_revision INTEGER NOT NULL,
  reservation_mission_revision INTEGER NOT NULL,
  reservation_prompt_revision INTEGER NOT NULL,
  reservation_prompt_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (team_id, authority_environment_id, idempotency_key)
);
CREATE INDEX idx_projection_mission_planning_mission
  ON projection_mission_planning (mission_id, team_id, authority_environment_id);
-- The GUI belongs to this environment, not to an individual mission.
CREATE UNIQUE INDEX idx_projection_mission_planning_gui_owner
  ON projection_mission_planning (authority_environment_id) WHERE gui_lease = 'held';
CREATE TABLE projection_mission_planning_receipts (
  command_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  authority_environment_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  planning_id TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of ddl.split(";")) {
    if (statement.trim().length > 0) yield* sql.unsafe(statement);
  }
});
