import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bridge_inbox_quarantine ADD COLUMN event_id TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_bridge_inbox_quarantine_event
    ON bridge_inbox_quarantine(owner, event_id)`;
});
