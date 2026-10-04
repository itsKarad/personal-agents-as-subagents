import assert from "node:assert/strict";
import { answer } from "./src/answer.js";

assert.equal(answer(), 42);
