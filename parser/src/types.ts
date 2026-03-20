/** Register dump: map from register index (0-12) to bigint value. Only non-zero registers are present. */
export type RegisterDump = Map<number, bigint>;

/** A memory read operation */
export interface MemRead {
  address: number;
  length: number;
  data: Uint8Array;
}

/** A memory write operation */
export interface MemWrite {
  address: number;
  length: number;
  data: Uint8Array;
}

/** A register write operation */
export interface SetReg {
  index: number;
  value: bigint;
}

/** Host actions performed during an ecalli */
export interface HostActions {
  memReads: MemRead[];
  memWrites: MemWrite[];
  regWrites: SetReg[];
  gasOverwrite: bigint | null;
}

/** An ecalli entry with its host actions */
export interface EcalliEntry {
  index: number;
  pc: number;
  gas: bigint;
  registers: RegisterDump;
  actions: HostActions;
}

/** Execution termination reason */
export type TerminationKind = "HALT" | "OOG" | { PANIC: bigint };

/** Execution termination line */
export interface Termination {
  kind: TerminationKind;
  pc: number;
  gas: bigint;
  registers: RegisterDump;
}

/** A complete ecalli trace */
export interface EcalliTrace {
  /** Optional context lines (implementation metadata, etc.) */
  contextLines: string[];
  /** The program blob (hex bytes) */
  program: Uint8Array;
  /** Initial memory writes (prelude) */
  initialMemWrites: MemWrite[];
  /** Start state */
  start: {
    pc: number;
    gas: bigint;
    registers: RegisterDump;
  };
  /** Ecalli entries */
  ecallis: EcalliEntry[];
  /** Execution termination */
  termination: Termination;
}
