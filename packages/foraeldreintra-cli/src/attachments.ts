import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { mkdir, open, lstat } from "node:fs/promises";
import { join, resolve, parse } from "node:path";
import {
  IntraError,
  type IntraClient,
  type Child,
  type Result,
  type Attachment,
} from "@foraeldreintra/api-client";

export async function privateDirectory(path: string) {
  const dir = resolve(path);
  let current = parse(dir).root;
  for (const part of dir.slice(current.length).split("/")) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new IntraError(
          "INSECURE_FILE",
          "Output directories must not be symlinked.",
        );
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).mode & 0o077)
    throw new IntraError(
      "INSECURE_FILE",
      "Output directory must have mode 700.",
    );
  return dir;
}
export function sniff(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")))
    return "doc";
  if (b.subarray(0, 5).toString() === "%PDF-") return "pdf";
  if (b.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) return "docx";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "jpg";
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "png";
  if (/^GIF8[79]a/.test(b.subarray(0, 6).toString())) return "gif";
  if (
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WEBP"
  )
    return "webp";
  throw new IntraError(
    "UNREADABLE_ATTACHMENT",
    "File is not a recognized PDF, DOCX, or image.",
  );
}
export async function downloadOne(
  client: IntraClient,
  child: Child,
  a: Attachment,
  directory: string,
) {
  const dir = await privateDirectory(directory);
  const { bytes } = await client.download(a.url, child);
  const ext = sniff(bytes),
    sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  await validateBytes(bytes, ext);
  const path = join(dir, `${sha256}.${ext}`);
  try {
    const f = await open(path, "wx", 0o600);
    try {
      await f.writeFile(bytes);
    } finally {
      await f.close();
    }
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
      throw new IntraError(
        "INSECURE_FILE",
        "Existing attachment file is unsafe.",
      );
    if (
      new Bun.CryptoHasher("sha256")
        .update(await Bun.file(path).arrayBuffer())
        .digest("hex") !== sha256
    )
      throw new IntraError(
        "CORRUPT_FILE",
        "Existing attachment checksum mismatch.",
      );
  }
  const mediaTypes: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    jpg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return {
    ...a,
    mediaType: mediaTypes[ext] ?? null,
    sha256,
    size: bytes.length,
    localPath: path,
  };
}
export async function downloadResult(
  client: IntraClient,
  result: Result,
  directory: string,
) {
  const seen = new Map<string, Attachment>();
  let errors = 0;
  for (const item of result.items) {
    for (let n = 0; n < item.attachments.length; n++) {
      const a = item.attachments[n]!;
      let downloaded = seen.get(a.url);
      if (!downloaded) {
        try {
          downloaded = await downloadOne(client, result.child, a, directory);
        } catch (e) {
          errors++;
          downloaded = {
            ...a,
            error: e instanceof IntraError ? e.code : "ATTACHMENT_ERROR",
          };
        }
        seen.set(a.url, downloaded);
      }
      item.attachments[n] = downloaded;
    }
  }
  if (errors) {
    result.complete = false;
    result.warnings.push(
      `${errors} attachment(s) could not be downloaded or recognized. Inspect attachment.error.`,
    );
  }
  return result;
}

export async function extractFile(file: string, out: string) {
  const dir = await privateDirectory(out);
  const { constants } = await import("node:fs");
  const f = await open(
    resolve(file),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let bytes: Buffer;
  try {
    const stat = await f.stat();
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024)
      throw new IntraError(
        "UNREADABLE_ATTACHMENT",
        "Input must be a file under 25 MiB.",
      );
    bytes = await f.readFile();
    if (bytes.length > 25 * 1024 * 1024)
      throw new IntraError("TOO_LARGE", "Input exceeds size limit.");
  } finally {
    await f.close();
  }
  const type = sniff(bytes);
  if (type === "docx") {
    const text = await runParser(
      "python3",
      [fileURLToPath(new URL("./extract-docx.py", import.meta.url)), dir],
      bytes,
    );
    return { file: resolve(file), type, ...JSON.parse(text) };
  }
  if (type === "doc") {
    const text = await legacyDocText(bytes);
    return {
      file: resolve(file),
      type,
      text,
      visualReviewRequired: true,
      warnings: [
        "Legacy Word text extraction does not extract embedded images or reproduce page layout. Open the retained original for visual reading.",
      ],
    };
  }
  if (type === "pdf") {
    const text = await runParser("pdftotext", ["-layout", "-", "-"], bytes);
    return {
      file: resolve(file),
      type,
      text,
      visualReviewRequired: true,
      warnings: [
        text.trim()
          ? "Text extraction does not include image-only information."
          : "No extractable text; PDF requires visual reading or OCR.",
      ],
    };
  }
  await validateBytes(bytes, type);
  return {
    file: resolve(file),
    type,
    text: null,
    visualReviewRequired: true,
    warnings: ["Image retained for visual reading; no OCR performed."],
  };
}

function runParser(
  command: string,
  args: string[],
  bytes: Uint8Array,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { timeout: 30000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error)
          reject(
            new IntraError(
              (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "DEPENDENCY_REQUIRED"
                : "UNREADABLE_ATTACHMENT",
              `Attachment parsing failed. Ensure ${command} is installed and the file is readable.`,
            ),
          );
        else resolve(stdout);
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(bytes);
  });
}
async function validateBytes(bytes: Uint8Array, type: string) {
  if (type === "doc") {
    await legacyDocText(bytes);
    return;
  }
  if (type === "pdf") {
    await runParser("pdftotext", ["-", "-"], bytes);
    return;
  }
  if (type === "docx") {
    await runParser(
      "python3",
      [
        "-c",
        `import sys,io,zipfile
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
a=z.infolist()
assert len(a)<10000 and sum(x.file_size for x in a)<100*1024*1024
assert "word/document.xml" in z.namelist() and "[Content_Types].xml" in z.namelist()
assert z.testzip() is None`,
      ],
      bytes,
    );
    return;
  }
  await runParser(
    "python3",
    [
      "-c",
      "import sys,io; from PIL import Image; im=Image.open(io.BytesIO(sys.stdin.buffer.read())); im.verify()",
    ],
    bytes,
  );
}

async function legacyDocText(bytes: Uint8Array) {
  if (process.platform !== "darwin")
    throw new IntraError(
      "DEPENDENCY_REQUIRED",
      "Legacy .doc parsing currently requires macOS textutil. PDF, DOCX, and images are supported independently.",
    );
  return runParser(
    "textutil",
    ["-convert", "txt", "-stdin", "-stdout", "-format", "doc"],
    bytes,
  );
}
