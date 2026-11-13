import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StoreData } from "./types";

const EMPTY: StoreData = { calls: [], bookings: [], messages: [] };

export type RemoteLog = {
  init(): Promise<void>;
  load(): Promise<StoreData | null>;
  save(data: StoreData): Promise<void>;
};

export class Store {
  private chain: Promise<void> = Promise.resolve();
  private memory: StoreData | null = null;
  private remote?: RemoteLog;
  remoteError?: string;

  constructor(readonly filePath: string) {}

  get persistent(): boolean {
    return Boolean(this.remote);
  }

  read(): StoreData {
    if (this.memory) return structuredClone(this.memory);
    return this.readFile();
  }

  isEmpty(): boolean {
    const data = this.read();
    return data.calls.length === 0 && data.bookings.length === 0;
  }

  async attachRemote(remote: RemoteLog): Promise<void> {
    await remote.init();
    const loaded = await remote.load();
    const remoteHas = Boolean(loaded && (loaded.calls.length || loaded.bookings.length || loaded.messages.length));
    this.remote = remote;
    this.memory = remoteHas && loaded ? loaded : this.readFile();
    if (remoteHas) this.writeFile(this.memory);
    else await remote.save(this.memory);
  }

  update(mutate: (data: StoreData) => void): Promise<StoreData> {
    let next: StoreData = structuredClone(EMPTY);
    const run = this.chain.then(async () => {
      const data = this.read();
      mutate(data);
      if (this.memory) this.memory = data;
      this.writeFile(data);
      if (this.remote) {
        try {
          await this.remote.save(data);
          this.remoteError = undefined;
        } catch (error) {
          this.remoteError = error instanceof Error ? error.message : "Could not save the call log";
          console.error(this.remoteError);
        }
      }
      next = data;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(() => structuredClone(next));
  }

  private readFile(): StoreData {
    if (!existsSync(this.filePath)) return structuredClone(EMPTY);
    const raw = readFileSync(this.filePath, "utf8");
    if (!raw.trim()) return structuredClone(EMPTY);
    const parsed = JSON.parse(raw) as StoreData;
    return {
      calls: parsed.calls ?? [],
      bookings: parsed.bookings ?? [],
      messages: parsed.messages ?? [],
    };
  }

  private writeFile(data: StoreData) {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      if (!this.remote) throw error;
      this.remoteError = error instanceof Error ? error.message : "Could not write the local log";
    }
  }
}
