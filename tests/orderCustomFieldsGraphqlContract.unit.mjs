import assertModule from "assert";
import { readFile } from "fs/promises";

const assert = assertModule.strict;
const schema = await readFile(new URL("../src/schemas/schema.graphql", import.meta.url), "utf8");

assert.match(schema, /input\s+OrderCustomFieldsInput\s*\{[\s\S]*timeZone:\s*String[\s\S]*\}/);

const orderInputMatch = schema.match(/input\s+OrderInput\s*\{([\s\S]*?)\n\}/);
assert.ok(orderInputMatch, "OrderInput definition must exist");
assert.match(orderInputMatch[1], /customFields:\s*OrderCustomFieldsInput/);

assert.doesNotMatch(
  orderInputMatch[1],
  /customFields:\s*(JSON|JSONObject|Object|Any)/,
  "OrderInput.customFields must remain narrowly typed",
);

console.log("PASS OrderInput customFields GraphQL contract");
