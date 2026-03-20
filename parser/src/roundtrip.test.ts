import { describe, expect, it } from "bun:test";
import { parse } from "./parser.js";
import { encode } from "./encoder.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const SPEC_EXAMPLE = `\
comment implementation typeberry 0.8.3
comment chain-id fluffy-testnet
comment accumulate
program 0x0102aabbccddeeff
memwrite 0x00001000 len=8 <- 0x0000000000000001
start pc=0 gas=10000 r07=0x10 r09=0x10000

ecalli=10 pc=42 gas=9980 r01=0x1 r03=0x1000
memread 0x00001000 len=4 -> 0x01020304
memread 0x00001020 len=8 -> 0x0000000000000040
memwrite 0x00002000 len=2 <- 0xffee
setreg r00 <- 0x100
setreg r02 <- 0x4
setgas <- 9950

HALT pc=42 gas=9920 r00=0x100 r02=0x4
`;

describe("parser", () => {
  it("parses the spec example", () => {
    const trace = parse(SPEC_EXAMPLE);

    expect(trace.comments).toEqual([
      "implementation typeberry 0.8.3",
      "chain-id fluffy-testnet",
      "accumulate",
    ]);
    expect(trace.program).toEqual(new Uint8Array([0x01, 0x02, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]));
    expect(trace.initialMemWrites).toHaveLength(1);
    expect(trace.initialMemWrites[0]!.address).toBe(0x1000);
    expect(trace.initialMemWrites[0]!.length).toBe(8);
    expect(trace.initialMemWrites[0]!.data).toEqual(
      new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]),
    );

    expect(trace.start.pc).toBe(0);
    expect(trace.start.gas).toBe(10000n);
    expect(trace.start.registers.size).toBe(2);
    expect(trace.start.registers.get(7)).toBe(0x10n);
    expect(trace.start.registers.get(9)).toBe(0x10000n);

    expect(trace.ecallis).toHaveLength(1);
    const ec = trace.ecallis[0]!;
    expect(ec.index).toBe(10);
    expect(ec.pc).toBe(42);
    expect(ec.gas).toBe(9980n);
    expect(ec.registers.get(1)).toBe(1n);
    expect(ec.registers.get(3)).toBe(0x1000n);

    expect(ec.actions.memReads).toHaveLength(2);
    expect(ec.actions.memReads[0]!.address).toBe(0x1000);
    expect(ec.actions.memReads[0]!.length).toBe(4);
    expect(ec.actions.memReads[1]!.address).toBe(0x1020);

    expect(ec.actions.memWrites).toHaveLength(1);
    expect(ec.actions.memWrites[0]!.address).toBe(0x2000);
    expect(ec.actions.memWrites[0]!.data).toEqual(new Uint8Array([0xff, 0xee]));

    expect(ec.actions.regWrites).toHaveLength(2);
    expect(ec.actions.regWrites[0]!.index).toBe(0);
    expect(ec.actions.regWrites[0]!.value).toBe(0x100n);
    expect(ec.actions.regWrites[1]!.index).toBe(2);
    expect(ec.actions.regWrites[1]!.value).toBe(4n);

    expect(ec.actions.gasOverwrite).toBe(9950n);

    expect(trace.termination.kind).toBe("HALT");
    expect(trace.termination.pc).toBe(42);
    expect(trace.termination.gas).toBe(9920n);
    expect(trace.termination.registers.get(0)).toBe(0x100n);
    expect(trace.termination.registers.get(2)).toBe(4n);
  });

  it("handles PANIC termination", () => {
    const input = `\
program 0xff
start pc=0 gas=100
PANIC=5 pc=10 gas=50 r01=0x1
`;
    const trace = parse(input);
    expect(trace.termination.kind).toEqual({ PANIC: 5n });
    expect(trace.termination.pc).toBe(10);
  });

  it("handles OOG termination", () => {
    const input = `\
program 0xff
start pc=0 gas=100
OOG pc=10 gas=0
`;
    const trace = parse(input);
    expect(trace.termination.kind).toBe("OOG");
    expect(trace.termination.gas).toBe(0n);
  });

  it("handles lines with prefix (e.g. TRACE logger)", () => {
    const input = `\
TRACE [  ecalli] comment my-impl v2
TRACE [  ecalli] program 0xaabb
TRACE [  ecalli] start pc=5 gas=100 r00=0x1
TRACE [  ecalli] HALT pc=10 gas=50
`;
    const trace = parse(input);
    expect(trace.comments).toEqual(["my-impl v2"]);
    expect(trace.program).toEqual(new Uint8Array([0xaa, 0xbb]));
    expect(trace.start.pc).toBe(5);
    expect(trace.start.registers.get(0)).toBe(1n);
    expect(trace.termination.kind).toBe("HALT");
  });

  it("does not match keywords inside other words in prefixes", () => {
    const input = `\
restarting service
programming notes
comment my-impl v1
program 0xaabb
start pc=0 gas=100
HALT pc=5 gas=50
`;
    const trace = parse(input);
    // "restarting" and "programming" should be ignored, not matched as "start"/"program"
    expect(trace.comments).toEqual(["my-impl v1"]);
    expect(trace.program).toEqual(new Uint8Array([0xaa, 0xbb]));
    expect(trace.start.pc).toBe(0);
  });

  it("throws on missing program line", () => {
    expect(() => parse("start pc=0 gas=100\nHALT pc=0 gas=0\n")).toThrow("Missing 'program'");
  });

  it("throws on missing start line", () => {
    expect(() => parse("program 0xff\nHALT pc=0 gas=0\n")).toThrow("Missing 'start'");
  });

  it("throws on missing termination", () => {
    expect(() => parse("program 0xff\nstart pc=0 gas=100\n")).toThrow("Missing termination");
  });

  it("handles ecalli with no host actions", () => {
    const input = `\
program 0xff
start pc=0 gas=1000
ecalli=5 pc=10 gas=900
HALT pc=20 gas=800
`;
    const trace = parse(input);
    expect(trace.ecallis).toHaveLength(1);
    expect(trace.ecallis[0]!.actions.memReads).toHaveLength(0);
    expect(trace.ecallis[0]!.actions.memWrites).toHaveLength(0);
    expect(trace.ecallis[0]!.actions.regWrites).toHaveLength(0);
    expect(trace.ecallis[0]!.actions.gasOverwrite).toBeNull();
  });

  it("handles multiple ecalli entries", () => {
    const input = `\
program 0xff
start pc=0 gas=5000
ecalli=1 pc=10 gas=4900
setgas <- 4890
ecalli=2 pc=20 gas=4800 r01=0xa
memread 0x00001000 len=4 -> 0xdeadbeef
setreg r00 <- 0x1
setgas <- 4750
ecalli=3 pc=30 gas=4700
memwrite 0x00002000 len=2 <- 0xabcd
setgas <- 4690
HALT pc=40 gas=4600
`;
    const trace = parse(input);
    expect(trace.ecallis).toHaveLength(3);
    expect(trace.ecallis[0]!.index).toBe(1);
    expect(trace.ecallis[1]!.index).toBe(2);
    expect(trace.ecallis[1]!.actions.memReads).toHaveLength(1);
    expect(trace.ecallis[1]!.actions.regWrites).toHaveLength(1);
    expect(trace.ecallis[2]!.index).toBe(3);
    expect(trace.ecallis[2]!.actions.memWrites).toHaveLength(1);
  });
});

describe("encoder", () => {
  it("sorts host actions per spec (address ascending, then hex payload)", () => {
    const trace = parse(`\
program 0xff
start pc=0 gas=5000
ecalli=1 pc=10 gas=4900
HALT pc=20 gas=4800
`);
    // Inject out-of-order actions
    trace.ecallis[0]!.actions.memReads = [
      { address: 0x2000, length: 2, data: new Uint8Array([0xaa, 0xbb]) },
      { address: 0x1000, length: 2, data: new Uint8Array([0xcc, 0xdd]) },
    ];
    trace.ecallis[0]!.actions.memWrites = [
      { address: 0x3000, length: 1, data: new Uint8Array([0xff]) },
      { address: 0x1000, length: 1, data: new Uint8Array([0x11]) },
    ];
    trace.ecallis[0]!.actions.regWrites = [
      { index: 5, value: 0xan },
      { index: 2, value: 0xbn },
    ];
    const encoded = encode(trace);
    const lines = encoded.split("\n");
    const ecalliIdx = lines.findIndex((l) => l.startsWith("ecalli="));
    // After ecalli line: reads sorted by address, then writes, then regs
    expect(lines[ecalliIdx + 1]).toBe("memread 0x00001000 len=2 -> 0xccdd");
    expect(lines[ecalliIdx + 2]).toBe("memread 0x00002000 len=2 -> 0xaabb");
    expect(lines[ecalliIdx + 3]).toBe("memwrite 0x00001000 len=1 <- 0x11");
    expect(lines[ecalliIdx + 4]).toBe("memwrite 0x00003000 len=1 <- 0xff");
    expect(lines[ecalliIdx + 5]).toBe("setreg r02 <- 0xb");
    expect(lines[ecalliIdx + 6]).toBe("setreg r05 <- 0xa");
  });

  it("encodes the spec example correctly", () => {
    const trace = parse(SPEC_EXAMPLE);
    const encoded = encode(trace);

    // Each significant line should be present
    expect(encoded).toContain("program 0x0102aabbccddeeff");
    expect(encoded).toContain("memwrite 0x00001000 len=8 <- 0x0000000000000001");
    expect(encoded).toContain("start pc=0 gas=10000 r07=0x10 r09=0x10000");
    expect(encoded).toContain("ecalli=10 pc=42 gas=9980 r01=0x1 r03=0x1000");
    expect(encoded).toContain("memread 0x00001000 len=4 -> 0x01020304");
    expect(encoded).toContain("setreg r00 <- 0x100");
    expect(encoded).toContain("setgas <- 9950");
    expect(encoded).toContain("HALT pc=42 gas=9920 r00=0x100 r02=0x4");
  });
});

describe("roundtrip", () => {
  it("roundtrips the spec example (encode → parse → encode)", () => {
    const trace1 = parse(SPEC_EXAMPLE);
    const encoded1 = encode(trace1);
    const trace2 = parse(encoded1);
    const encoded2 = encode(trace2);

    // Second roundtrip should produce identical output
    expect(encoded2).toBe(encoded1);
  });

  it("roundtrips PANIC termination", () => {
    const input = `\
program 0xaabbcc
start pc=0 gas=5000 r01=0xff
ecalli=3 pc=10 gas=4900 r01=0xff r02=0x1
setreg r00 <- 0x42
setgas <- 4880
PANIC=7 pc=20 gas=4800 r00=0x42 r01=0xff r02=0x1
`;
    const t1 = parse(input);
    const e1 = encode(t1);
    const t2 = parse(e1);
    const e2 = encode(t2);
    expect(e2).toBe(e1);
    expect(t2.termination.kind).toEqual({ PANIC: 7n });
  });

  it("roundtrips OOG termination", () => {
    const input = `\
program 0xdd
start pc=0 gas=100
OOG pc=5 gas=0 r03=0xabc
`;
    const t1 = parse(input);
    const e1 = encode(t1);
    const t2 = parse(e1);
    const e2 = encode(t2);
    expect(e2).toBe(e1);
  });

  it("roundtrips trace with no ecallis", () => {
    const input = `\
program 0x01
start pc=0 gas=500
HALT pc=10 gas=400
`;
    const t1 = parse(input);
    const e1 = encode(t1);
    const t2 = parse(e1);
    const e2 = encode(t2);
    expect(e2).toBe(e1);
    expect(t1.ecallis).toHaveLength(0);
  });

  it("roundtrips trace with multiple initial memwrites", () => {
    const input = `\
program 0xfe
memwrite 0x00001000 len=4 <- 0xaabbccdd
memwrite 0x00002000 len=2 <- 0x1234
start pc=0 gas=1000
HALT pc=5 gas=900
`;
    const t1 = parse(input);
    expect(t1.initialMemWrites).toHaveLength(2);
    const e1 = encode(t1);
    const t2 = parse(e1);
    const e2 = encode(t2);
    expect(e2).toBe(e1);
  });

  it("roundtrips trace with large register values (64-bit)", () => {
    const input = `\
program 0x00
start pc=0 gas=100 r01=0xffffffffffffffff r05=0x8000000000000000
HALT pc=5 gas=50 r01=0xffffffffffffffff r05=0x8000000000000000
`;
    const t1 = parse(input);
    expect(t1.start.registers.get(1)).toBe(0xffffffffffffffffn);
    expect(t1.start.registers.get(5)).toBe(0x8000000000000000n);
    const e1 = encode(t1);
    const t2 = parse(e1);
    const e2 = encode(t2);
    expect(e2).toBe(e1);
  });
});

describe("roundtrip with real trace files", () => {
  const storageDir = join(import.meta.dir, "../../examples/storage");

  it("roundtrips a real storage trace file (trace-001.log)", async () => {
    const content = await readFile(join(storageDir, "trace-001.log"), "utf-8");
    const trace = parse(content);
    const encoded = encode(trace);
    const trace2 = parse(encoded);
    const encoded2 = encode(trace2);
    expect(encoded2).toBe(encoded);

    // Sanity checks on the parsed data
    expect(trace.program.length).toBeGreaterThan(0);
    expect(trace.ecallis.length).toBeGreaterThan(0);
    expect(trace.termination.kind).toBe("HALT");
  });

  it("roundtrips all storage trace files", async () => {
    const files = await readdir(storageDir);
    const traceFiles = files.filter((f) => f.endsWith(".log")).sort();
    expect(traceFiles.length).toBeGreaterThan(0);

    for (const file of traceFiles) {
      const content = await readFile(join(storageDir, file), "utf-8");
      const trace = parse(content);
      const encoded = encode(trace);
      const trace2 = parse(encoded);
      const encoded2 = encode(trace2);
      expect(encoded2).toBe(encoded);
    }
  });

  it("roundtrips the prefixed io-trace-output.log (strips prefixes)", async () => {
    const content = await readFile(
      join(import.meta.dir, "../../examples/io-trace-output.log"),
      "utf-8",
    );
    const trace = parse(content);

    // After parsing, comment lines should not contain the prefix
    // since they're lines before program that don't match keywords
    expect(trace.program.length).toBeGreaterThan(0);
    expect(trace.ecallis.length).toBeGreaterThan(0);

    // Roundtrip: encode produces clean output, re-parse should match
    const encoded = encode(trace);
    const trace2 = parse(encoded);
    const encoded2 = encode(trace2);
    expect(encoded2).toBe(encoded);
  });
});
