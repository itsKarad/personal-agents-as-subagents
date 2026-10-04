import assert from "node:assert/strict";
import { normalizeLabel } from "./src/label.js";

assert.equal(normalizeLabel("  Muse  "), "muse");
