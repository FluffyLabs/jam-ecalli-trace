# PVM Ecalli Trace

A standardized, human-readable trace format for recording PVM host call (ecalli) executions.
The format captures program state, memory operations, and register changes during host calls (both read and written), enabling cross-implementation comparison and replay-based debugging.

**Status: Proposal** (JIP number pending)

## Repository Contents

| Path | Description |
|------|-------------|
| [`ecalli-trace-jip.md`](ecalli-trace-jip.md) | Full format specification |
| [`parser/`](parser/) | TypeScript parser and encoder library |
| [`examples/`](examples/) | Real-world trace files for testing |

## Quick Example

A trace file looks like this:

```
comment implementation typeberry 0.8.3
comment accumulate
program 0x0102aabbccddeeff
memwrite 0x00001000 len=8 <- 0x0000000000000001
start pc=0 gas=10000 r07=0x10 r09=0x10000

ecalli=10 pc=42 gas=9980 r01=0x1 r03=0x1000
memread 0x00001000 len=4 -> 0x01020304
memwrite 0x00002000 len=2 <- 0xffee
setreg r00 <- 0x100
setgas <- 9950

HALT pc=42 gas=9920 r00=0x100 r02=0x4
```

## Parser Usage

```typescript
import { parse, encode } from "ecalli-trace-parser";

const trace = parse(traceFileContent);

console.log(trace.ecallis.length);           // number of host calls
console.log(trace.termination.kind);         // "HALT" | "OOG" | { PANIC: bigint }
console.log(trace.start.gas);                // initial gas

const normalized = encode(trace);            // re-encode to canonical form
```

See the [parser README](parser/README.md) for full API details.

## Design Rationale

- **Human-readable text** — newline-delimited, diffable with standard tools. Two traces from different implementations can be compared with a simple `diff` after stripping logger prefixes (normalizing).
- **Hex encoding for data blobs** — chosen over base64 to allow direct sub-blob searches (e.g. grep for a specific constant in memory read/write data).
- **Self-contained** — each trace includes the full program blob and initial memory state, enabling stateless re-execution without external dependencies.
- **Logger-friendly** — lines may be prefixed/suffixed with arbitrary data (e.g. timestamps, log levels), so implementations can emit traces through their existing logging infrastructure.

## Tool Support

Projects that currently support the ecalli trace format:

- [**anan-as**](https://github.com/tomusdrw/anan-as) — PVM implementation with trace replay capability
- [**PVM Debugger**](https://pvm.fluffylabs.dev) — browser-based PVM debugger with trace file loading

## License

[MIT](LICENSE)
