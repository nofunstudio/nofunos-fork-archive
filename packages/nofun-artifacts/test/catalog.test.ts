import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { validateArtifactSpec } from "../src/catalog.ts";

NodeTest.test(
  "DataTable decimal columns compile to the number format understood by pinned runtimes",
  () => {
    const table = {
      component: "DataTable",
      props: {
        columns: [{ key: "amount", label: "Amount", format: "decimal" }],
        rows: [{ amount: 1234.56 }],
      },
    };
    const spec = { root: { component: "Stack", children: [table] } };
    const result = validateArtifactSpec(spec);
    NodeAssert.deepEqual(result.root.children?.[0]?.props?.columns, [
      { key: "amount", label: "Amount", format: "number" },
    ]);
    NodeAssert.equal(table.props.columns[0]?.format, "decimal", "caller input stays unchanged");
  },
);

NodeTest.test("invalid table formats report the column path and allowed values", () => {
  NodeAssert.throws(
    () =>
      validateArtifactSpec({
        root: {
          component: "DataTable",
          props: { columns: [{ key: "n", label: "N", format: "scientific" }], rows: [] },
        },
      }),
    /root\.props\.columns\[0\]\.format: expected one of .*"decimal".*"number".*got "scientific"/,
  );
});
