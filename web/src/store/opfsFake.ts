/**
 * An in-memory OPFS, for tests that run under node.
 *
 * ⚠️ WHAT THIS CAN AND CANNOT PROVE. It implements the handle API `opfs.ts` walks, so it exercises
 * the real path→handle adapter, the real sort, the real crumbs, the real kit rewriting and the real
 * package collision handling. It does NOT prove that Chrome's OPFS behaves this way — only Chrome
 * can, and `web/tools/browser_opfs_test.mjs` is where that is settled. Green tests here are a
 * statement about our logic, not about the browser. This distinction has bitten this migration
 * before; it is written down so it does not again.
 *
 * `lastModified` is a monotonic counter rather than a clock: two writes in the same millisecond
 * would otherwise tie and make the date sort untestable.
 */
let clock = 1;

class FakeFile {
  constructor(
    private bytes: Uint8Array,
    readonly lastModified: number,
  ) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.slice().buffer;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }
}

class FakeFileHandle {
  readonly kind = "file" as const;
  bytes = new Uint8Array(0);
  lastModified = clock++;

  constructor(readonly name: string) {}

  async getFile(): Promise<FakeFile> {
    return new FakeFile(this.bytes, this.lastModified);
  }

  async createWritable(): Promise<{
    write(data: Uint8Array | string): Promise<void>;
    close(): Promise<void>;
  }> {
    // Real `createWritable()` truncates: the write is a full replace, not an append.
    let staged = new Uint8Array(0);
    return {
      write: async (data: Uint8Array | string) => {
        staged = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
      },
      close: async () => {
        this.bytes = staged;
        this.lastModified = clock++;
      },
    };
  }
}

class FakeDirHandle {
  readonly kind = "directory" as const;
  private children = new Map<string, FakeDirHandle | FakeFileHandle>();

  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== "directory") throw notFound(name, "TypeMismatchError");
      return existing;
    }
    if (!opts?.create) throw notFound(name);
    const dir = new FakeDirHandle(name);
    this.children.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== "file") throw notFound(name, "TypeMismatchError");
      return existing;
    }
    if (!opts?.create) throw notFound(name);
    const file = new FakeFileHandle(name);
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string, _opts?: { recursive?: boolean }): Promise<void> {
    if (!this.children.delete(name)) throw notFound(name);
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<
    [string, FakeDirHandle | FakeFileHandle]
  > {
    // A copy, so a caller that writes during the walk does not invalidate the iterator.
    for (const entry of [...this.children.entries()]) yield entry;
  }
}

function notFound(name: string, kind = "NotFoundError"): Error {
  const err = new Error(`${kind}: ${name}`);
  err.name = kind;
  return err;
}

/**
 * Install a fresh in-memory OPFS as `navigator.storage.getDirectory()`. Returns a reset function —
 * call it between tests, or one test's library leaks into the next.
 */
export function installFakeOpfs(): () => void {
  let root = new FakeDirHandle("");
  const storage = { getDirectory: async () => root as unknown as FileSystemDirectoryHandle };

  const globalAny = globalThis as unknown as { navigator?: unknown };
  const previous = globalAny.navigator;

  Object.defineProperty(globalAny, "navigator", {
    value: { ...(previous ?? {}), storage },
    configurable: true,
    writable: true,
  });

  return () => {
    root = new FakeDirHandle("");
    Object.defineProperty(globalAny, "navigator", {
      value: previous,
      configurable: true,
      writable: true,
    });
  };
}
