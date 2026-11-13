import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StoreData } from "./types";

const EMPTY: StoreData = { calls: [], bookings: [], messages: [] };

export class Store {
  private chain: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  read(): StoreData {
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

  isEmpty(): boolean {
    const data = this.read();
    return data.calls.length === 0 && data.bookings.length === 0;
  }

  update(mutate: (data: StoreData) => void): Promise<StoreData> {
    let next: StoreData = structuredClone(EMPTY);
    const run = this.chain.then(() => {
      const data = this.read();
      mutate(data);
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(data, null, 2));
      next = data;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(() => structuredClone(next));
  }
}
