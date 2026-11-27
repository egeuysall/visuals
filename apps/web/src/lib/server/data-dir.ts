import "server-only";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function dataDir(): string {
  const dir = process.env.VISUALS_DATA_DIR ?? join(process.cwd(), ".data");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
