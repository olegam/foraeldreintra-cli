import { constants } from "node:fs";
import { open, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { IntraError } from "@foraeldreintra/api-client";
export const home =
  process.env.FORAELDREINTRA_CLI_HOME ?? join(homedir(), ".foraeldreintra-cli");
export const sessionPath = join(home, "session.json");
export async function privateRead(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid?.())
      throw new IntraError(
        "INSECURE_FILE",
        "Private files must be owned by you and have mode 600.",
      );
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}
export async function privateWrite(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(data));
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
