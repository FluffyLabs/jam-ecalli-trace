import type {
  EcalliEntry,
  EcalliTrace,
  MemWrite,
  RegisterDump,
  Termination,
  TerminationKind,
} from "./types.ts";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${clean.length}`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

function parseAddress(hex: string): number {
  return parseInt(hex, 16);
}

function parseRegisterDump(tokens: string[]): RegisterDump {
  const regs: RegisterDump = new Map();
  for (const token of tokens) {
    const match = token.match(/^r(\d+)=(0x[0-9a-fA-F]+)$/);
    if (match) {
      regs.set(parseInt(match[1]!, 10), BigInt(match[2]!));
    }
  }
  return regs;
}

function parseKeyValue(token: string): [string, string] | null {
  const idx = token.indexOf("=");
  if (idx === -1) return null;
  return [token.substring(0, idx), token.substring(idx + 1)];
}

/**
 * Tries to extract a known line from potentially prefixed/suffixed text.
 * Returns the matched content or null if line doesn't contain a known keyword.
 */
const KEYWORDS = [
  "context",
  "program",
  "memwrite",
  "memread",
  "start",
  "ecalli=",
  "setreg",
  "setgas",
  "HALT",
  "PANIC=",
  "OOG",
];

function extractKnownLine(line: string): string | null {
  const tokens = line.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    for (const kw of KEYWORDS) {
      if (kw.endsWith("=")) {
        // Prefix match for ecalli= and PANIC=
        if (token.startsWith(kw)) {
          return tokens.slice(i).join(" ");
        }
      } else {
        // Exact token match — avoids matching "start" inside "restart"
        if (token === kw) {
          return tokens.slice(i).join(" ");
        }
      }
    }
  }
  return null;
}

export function parse(input: string): EcalliTrace {
  const lines = input.split("\n");
  const contextLines: string[] = [];
  let program: Uint8Array | null = null;
  const initialMemWrites: MemWrite[] = [];
  let start: EcalliTrace["start"] | null = null;
  const ecallis: EcalliEntry[] = [];
  let termination: Termination | null = null;
  let currentEcalli: EcalliEntry | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;

    const extracted = extractKnownLine(trimmed);
    if (extracted === null) {
      continue;
    }

    const tokens = extracted.split(" ");
    const first = tokens[0]!;

    if (first === "context") {
      contextLines.push(tokens.slice(1).join(" "));
      continue;
    }

    if (first === "program") {
      program = hexToBytes(tokens[1]!);
      continue;
    }

    if (first === "memwrite" && start === null) {
      // Prelude memwrite
      const addr = parseAddress(tokens[1]!);
      const lenToken = tokens[2]!; // len=N
      const len = parseInt(lenToken.split("=")[1]!, 10);
      // tokens[3] is "<-"
      const data = hexToBytes(tokens[4]!);
      initialMemWrites.push({ address: addr, length: len, data });
      continue;
    }

    if (first === "start") {
      const kv: Record<string, string> = {};
      const regTokens: string[] = [];
      for (let i = 1; i < tokens.length; i++) {
        const pair = parseKeyValue(tokens[i]!);
        if (pair && pair[0]!.startsWith("r") && /^\d+$/.test(pair[0]!.slice(1))) {
          regTokens.push(tokens[i]!);
        } else if (pair) {
          kv[pair[0]] = pair[1];
        }
      }
      start = {
        pc: parseInt(kv["pc"]!, 10),
        gas: BigInt(kv["gas"]!),
        registers: parseRegisterDump(regTokens),
      };
      continue;
    }

    if (first.startsWith("ecalli=")) {
      // Finalize previous ecalli if any
      if (currentEcalli) {
        ecallis.push(currentEcalli);
      }
      const kv: Record<string, string> = {};
      const regTokens: string[] = [];
      for (const token of tokens) {
        const pair = parseKeyValue(token);
        if (pair && pair[0]!.startsWith("r") && /^\d+$/.test(pair[0]!.slice(1))) {
          regTokens.push(token);
        } else if (pair) {
          kv[pair[0]] = pair[1];
        }
      }
      currentEcalli = {
        index: parseInt(kv["ecalli"]!, 10),
        pc: parseInt(kv["pc"]!, 10),
        gas: BigInt(kv["gas"]!),
        registers: parseRegisterDump(regTokens),
        actions: {
          memReads: [],
          memWrites: [],
          regWrites: [],
          gasOverwrite: null,
        },
      };
      continue;
    }

    if (first === "memread" && currentEcalli) {
      const addr = parseAddress(tokens[1]!);
      const len = parseInt(tokens[2]!.split("=")[1]!, 10);
      // tokens[3] is "->"
      const data = hexToBytes(tokens[4]!);
      currentEcalli.actions.memReads.push({ address: addr, length: len, data });
      continue;
    }

    if (first === "memwrite" && currentEcalli) {
      const addr = parseAddress(tokens[1]!);
      const len = parseInt(tokens[2]!.split("=")[1]!, 10);
      // tokens[3] is "<-"
      const data = hexToBytes(tokens[4]!);
      currentEcalli.actions.memWrites.push({ address: addr, length: len, data });
      continue;
    }

    if (first === "setreg" && currentEcalli) {
      // setreg r{idx} <- {hex-value}
      const regMatch = tokens[1]!.match(/^r(\d+)$/);
      if (regMatch) {
        const idx = parseInt(regMatch[1]!, 10);
        // tokens[2] is "<-"
        const value = BigInt(tokens[3]!);
        currentEcalli.actions.regWrites.push({ index: idx, value });
      }
      continue;
    }

    if (first === "setgas" && currentEcalli) {
      // setgas <- {gas}
      // tokens[1] is "<-"
      currentEcalli.actions.gasOverwrite = BigInt(tokens[2]!);
      continue;
    }

    // Termination lines
    if (first === "HALT" || first === "OOG" || first.startsWith("PANIC=")) {
      // Finalize current ecalli
      if (currentEcalli) {
        ecallis.push(currentEcalli);
        currentEcalli = null;
      }

      let kind: TerminationKind;
      let restTokens: string[];

      if (first === "HALT") {
        kind = "HALT";
        restTokens = tokens.slice(1);
      } else if (first === "OOG") {
        kind = "OOG";
        restTokens = tokens.slice(1);
      } else {
        // PANIC={argument}
        const panicVal = BigInt(first.split("=")[1]!);
        kind = { PANIC: panicVal };
        restTokens = tokens.slice(1);
      }

      const kv: Record<string, string> = {};
      const regTokens: string[] = [];
      for (const token of restTokens) {
        const pair = parseKeyValue(token);
        if (pair && pair[0]!.startsWith("r") && /^\d+$/.test(pair[0]!.slice(1))) {
          regTokens.push(token);
        } else if (pair) {
          kv[pair[0]] = pair[1];
        }
      }
      termination = {
        kind,
        pc: parseInt(kv["pc"]!, 10),
        gas: BigInt(kv["gas"]!),
        registers: parseRegisterDump(regTokens),
      };
      continue;
    }
  }

  // Edge case: last ecalli without termination
  if (currentEcalli) {
    ecallis.push(currentEcalli);
  }

  if (!program) {
    throw new Error("Missing 'program' line in trace");
  }
  if (!start) {
    throw new Error("Missing 'start' line in trace");
  }
  if (!termination) {
    throw new Error("Missing termination line (HALT/OOG/PANIC) in trace");
  }

  return {
    contextLines,
    program,
    initialMemWrites,
    start,
    ecallis,
    termination,
  };
}
