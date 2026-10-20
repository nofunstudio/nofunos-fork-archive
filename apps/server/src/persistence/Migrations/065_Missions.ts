import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Mission events and receipts stay in the existing application log and
  // command table. This is their rebuildable read model, not another authority.
  yield* sql`
    CREATE TABLE projection_missions (
      mission_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      authority_environment_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    ALTER TABLE orchestration_command_receipts
    ADD COLUMN request_hash TEXT
  `;
});
