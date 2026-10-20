import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE bridge_inbox (
    owner TEXT NOT NULL, event_id TEXT NOT NULL, event_json TEXT NOT NULL,
    route_json TEXT, status TEXT NOT NULL, reason TEXT NOT NULL,
    received_at TEXT NOT NULL, event_at TEXT NOT NULL, last_attempt_at TEXT, delivered_at TEXT,
    command_id TEXT, message_id TEXT, receipt_sequence INTEGER,
    PRIMARY KEY (owner, event_id)
  )`;
  yield* sql`CREATE INDEX bridge_inbox_pending ON bridge_inbox(owner, status, last_attempt_at)`;
  yield* sql`CREATE TABLE bridge_inbox_consumers (
    owner TEXT PRIMARY KEY, replay_from TEXT NOT NULL, cursor TEXT,
    lease_token TEXT, lease_until TEXT
  )`;
});
