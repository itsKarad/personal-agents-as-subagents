import assert from "node:assert/strict";
import { displayName } from "./src/name.js";

assert.equal(displayName("Ada   Lovelace"), "Ada Lovelace");
