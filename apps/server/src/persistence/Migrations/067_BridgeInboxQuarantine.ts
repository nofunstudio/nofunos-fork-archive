import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keep rejected payloads separate so a reused event ID cannot overwrite a valid delivery.
  yield* sql`CREATE TABLE bridge_inbox_quarantine (
    owner TEXT NOT NULL, payload_digest TEXT NOT NULL, event_json TEXT NOT NULL,
    reason TEXT NOT NULL, received_at TEXT NOT NULL,
    PRIMARY KEY (owner, payload_digest)
  )`;
});
