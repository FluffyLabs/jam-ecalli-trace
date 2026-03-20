import { readFile } from "node:fs/promises";
import { parse } from "./src/parser.js";
import { encode } from "./src/encoder.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: bun cli.ts <trace-file>");
  process.exit(1);
}

const content = await readFile(file, "utf-8");
const trace = parse(content);
const encoded = encode(trace);
const trace2 = parse(encoded);
const encoded2 = encode(trace2);

if (encoded !== encoded2) {
  console.error("FAIL: roundtrip mismatch");
  process.exit(1);
}

console.log(`program: ${trace.program.length} bytes`);
console.log(`initial memwrites: ${trace.initialMemWrites.length}`);
console.log(`start: pc=${trace.start.pc} gas=${trace.start.gas}`);
console.log(`ecallis: ${trace.ecallis.length}`);
const kind =
  typeof trace.termination.kind === "string"
    ? trace.termination.kind
    : `PANIC=${trace.termination.kind.PANIC}`;
console.log(`termination: ${kind} pc=${trace.termination.pc} gas=${trace.termination.gas}`);
console.log("roundtrip: OK");
