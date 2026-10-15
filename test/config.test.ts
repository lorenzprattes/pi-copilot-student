import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expandHomePath } from "../src/config.ts";

test("expands quoted home paths consistently with Pi", () => {
  assert.equal(expandHomePath("~/pi-classroom"), join(homedir(), "pi-classroom"));
  assert.equal(expandHomePath("~"), homedir());
  assert.equal(expandHomePath("./agent"), "./agent");
});
