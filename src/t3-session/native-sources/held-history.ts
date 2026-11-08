/** Local capabilities produced only by the protected native resource owner.
 * NOT wire schemas, transferable grants, or factories for callbacks. The
 * prospective source-owner grant producer must recognize the exact live root;
 * current admin/pairing or a physical T3 lease cannot mint it. The native
 * producer/composition is REQUIRED and UNBOUND at this checkpoint. */
export interface HeldNativeHistoryEntry {
  readonly entryKey: string
  /** Relative native layout name, for structural format selection only. Never
   * reopen this name in JavaScript or use it as human/ownership evidence. */
  readonly relativeName: string
  readonly kind: 'file' | 'directory' | 'unsupported'
  readonly revision: string
  readonly size: number
  readonly modifiedAt: string
}

export interface HeldNativeHistoryFile {
  readonly entryKey: string
  readonly revision: string
  readonly size: number
  /** Reads from the SAME held handle; length 1..65536, no path reopen. Native
   * implementation checks owner, DACL, identity and admission at each read. */
  read(offset: number, length: number): Promise<Uint8Array>
  recheck(): Promise<void>
}

export interface HeldNativeHistoryRoot {
  readonly source: 'claude' | 'codex'
  readonly admittedRootKey: string
  readonly physicalRootKey: string
  /** Stable for the same inventory snapshot across read leases, not a random
   * callback ID. Must change on admitted namespace/content revisions. */
  readonly generation: string
  /** Enumerates only the admitted history namespace. Cursor belongs to this
   * live generation. A final complete:false page retains failure reasons;
   * absent entries must not be interpreted as deletions in that case. */
  enumerate(input: { readonly cursor?: string; readonly limit: number }): Promise<{
    readonly generation: string
    readonly entries: readonly HeldNativeHistoryEntry[]
    readonly nextCursor: string | null
    readonly complete: boolean
    readonly reasons: readonly string[]
  }>
  /** Resolves an issued entry key and expected revision inside the held root.
   * Check the actual file's DACL/owner before delivering the byte capability.
   * Keep ancestor/reparse/rename fences until the callback has exited. */
  withFile<A>(entryKey: string, revision: string,
    use: (file: HeldNativeHistoryFile) => Promise<A>): Promise<A>
  recheck(): Promise<void>
}
