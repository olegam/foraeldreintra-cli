import { test, expect } from "bun:test";
import { mkdtemp, stat, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateWrite, privateRead } from "./state";
test("private storage permissions and symlink rejection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "intra-test-"));
  try {
    const path = join(dir, "state.json");
    await privateWrite(path, { test: true });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await privateRead(path)).toEqual({ test: true });
    await symlink(path, join(dir, "link"));
    await expect(privateRead(join(dir, "link"))).rejects.toThrow();
    await chmod(path, 0o644);
    await expect(privateRead(path)).rejects.toMatchObject({
      code: "INSECURE_FILE",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
