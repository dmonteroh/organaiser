import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function withTempWorkspace<T>(
  fn: (dir: string) => T | Promise<T>,
): Promise<T> {
  const root = process.env.ORGA_TEST_WORKSPACE ?? os.tmpdir();
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.realpath(await fs.mkdtemp(path.join(root, "orga-")));

  let ok = false;
  try {
    const result = await fn(dir);
    ok = true;
    return result;
  } finally {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (removalError) {
      if (ok) throw removalError;
    }
  }
}
