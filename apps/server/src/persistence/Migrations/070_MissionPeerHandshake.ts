import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Frozen migration64. Replay tombstones are retained across process restarts.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`
CREATE TABLE mission_peer_handshake_nonces (
  scope_digest TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('sender', 'receiver')),
  nonce TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  PRIMARY KEY (scope_digest, direction, nonce)
);`);
});
