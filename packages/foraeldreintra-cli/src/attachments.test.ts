import { test, expect } from "bun:test";
import { mkdtemp, rm, symlink, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sniff,
  privateDirectory,
  extractFile,
  downloadOne,
} from "./attachments";
import { IntraClient } from "@foraeldreintra/api-client";
test("HTML login responses and unknown bytes are not accepted as files", () => {
  expect(() => sniff(new TextEncoder().encode("<html>Login</html>"))).toThrow();
  expect(sniff(new TextEncoder().encode("%PDF-1.5"))).toBe("pdf");
});
test("attachment output rejects symlink directories", async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "intra-attachments-"),
  );
  try {
    await symlink(root, join(root, "link"));
    await expect(privateDirectory(join(root, "link"))).rejects.toMatchObject({
      code: "INSECURE_FILE",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("malformed JPEG is detected before reporting a successful download", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "intra-corrupt-"));
  const school = "https://school.m.skoleintra.dk";
  const client = new IntraClient(school, undefined, (() =>
    Promise.resolve(
      new Response(new Uint8Array([255, 216, 255, 0])),
    )) as unknown as typeof fetch);
  try {
    await expect(
      downloadOne(
        client,
        { id: "1", name: "A", path: "/parent/1/A" },
        {
          id: "a",
          name: "a.jpg",
          url: school + "/file/messageattach/a/a.jpg",
          size: null,
          mediaType: "image/jpeg",
        },
        root,
      ),
    ).rejects.toMatchObject({ code: "UNREADABLE_ATTACHMENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("DOCX extraction preserves text and embedded media and rejects zip traversal", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "intra-docx-"));
  const make = (unsafe: boolean) =>
    Bun.spawnSync([
      "python3",
      "-c",
      `import io,zipfile,sys
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 z.writestr('[Content_Types].xml','<Types/>')
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Fixture text</w:t></w:r></w:p></w:body></w:document>')
 z.writestr('${unsafe ? "../escape" : "word/media/image.png"}',b'not an image')
sys.stdout.buffer.write(b.getvalue())`,
    ]).stdout;
  try {
    const path = join(root, "a.docx");
    await Bun.write(path, make(false));
    const out = await extractFile(path, join(root, "out"));
    expect(out.text).toContain("Fixture text");
    expect(out.images).toHaveLength(1);
    expect(out.images[0].error).toBe("UNREADABLE_EMBEDDED_IMAGE");
    expect(out.extractionComplete).toBe(false);
    expect((await stat(out.images[0].path)).mode & 0o777).toBe(0o600);
    await Bun.write(path, make(true));
    await expect(extractFile(path, join(root, "out"))).rejects.toMatchObject({
      code: "UNREADABLE_ATTACHMENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
