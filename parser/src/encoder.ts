import type {
  EcalliTrace,
  MemRead,
  MemWrite,
  RegisterDump,
  SetReg,
  TerminationKind,
} from "./types.js";

function bytesToHex(bytes: Uint8Array): string {
  let hex = "0x";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

function formatAddress(addr: number): string {
  return "0x" + addr.toString(16).padStart(8, "0");
}

function formatRegValue(value: bigint): string {
  return "0x" + value.toString(16);
}

function formatRegisterDump(regs: RegisterDump): string {
  const entries = [...regs.entries()]
    .filter(([, v]) => v !== 0n)
    .sort((a, b) => a[0] - b[0]);

  return entries
    .map(([idx, val]) => `r${idx.toString().padStart(2, "0")}=${formatRegValue(val)}`)
    .join(" ");
}

function formatMemWrite(mw: MemWrite): string {
  return `memwrite ${formatAddress(mw.address)} len=${mw.length} <- ${bytesToHex(mw.data)}`;
}

function formatMemRead(mr: MemRead): string {
  return `memread ${formatAddress(mr.address)} len=${mr.length} -> ${bytesToHex(mr.data)}`;
}

function formatSetReg(sr: SetReg): string {
  return `setreg r${sr.index.toString().padStart(2, "0")} <- ${formatRegValue(sr.value)}`;
}

function formatTerminationKind(kind: TerminationKind): string {
  if (kind === "HALT") return "HALT";
  if (kind === "OOG") return "OOG";
  return `PANIC=${kind.PANIC}`;
}

export function encode(trace: EcalliTrace): string {
  const lines: string[] = [];

  // Comment lines
  for (const c of trace.comments) {
    lines.push(`comment ${c}`);
  }

  // Program
  lines.push(`program ${bytesToHex(trace.program)}`);

  // Initial memory writes
  for (const mw of trace.initialMemWrites) {
    lines.push(formatMemWrite(mw));
  }

  // Start
  const regDump = formatRegisterDump(trace.start.registers);
  const startLine = `start pc=${trace.start.pc} gas=${trace.start.gas}${regDump ? " " + regDump : ""}`;
  lines.push(startLine);

  // Ecalli entries
  for (const ec of trace.ecallis) {
    const ecRegDump = formatRegisterDump(ec.registers);
    const ecLine = `ecalli=${ec.index} pc=${ec.pc} gas=${ec.gas}${ecRegDump ? " " + ecRegDump : ""}`;
    lines.push(ecLine);

    // Host actions: reads, writes, reg writes, gas — sorted per spec
    const sortedMemReads = [...ec.actions.memReads].sort((a, b) => {
      if (a.address !== b.address) return a.address - b.address;
      return bytesToHex(a.data).localeCompare(bytesToHex(b.data));
    });
    for (const mr of sortedMemReads) {
      lines.push(formatMemRead(mr));
    }
    const sortedMemWrites = [...ec.actions.memWrites].sort((a, b) => {
      if (a.address !== b.address) return a.address - b.address;
      return bytesToHex(a.data).localeCompare(bytesToHex(b.data));
    });
    for (const mw of sortedMemWrites) {
      lines.push(formatMemWrite(mw));
    }
    const sortedRegWrites = [...ec.actions.regWrites].sort((a, b) => {
      if (a.index !== b.index) return a.index - b.index;
      return formatRegValue(a.value).localeCompare(formatRegValue(b.value));
    });
    for (const sr of sortedRegWrites) {
      lines.push(formatSetReg(sr));
    }
    if (ec.actions.gasOverwrite !== null) {
      lines.push(`setgas <- ${ec.actions.gasOverwrite}`);
    }
  }

  // Termination
  const termRegDump = formatRegisterDump(trace.termination.registers);
  const termLine = `${formatTerminationKind(trace.termination.kind)} pc=${trace.termination.pc} gas=${trace.termination.gas}${termRegDump ? " " + termRegDump : ""}`;
  lines.push(termLine);

  return lines.join("\n") + "\n";
}
