#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import {
  IntraClient,
  IntraError,
  CookieJar,
  ContentReader,
  type Result,
} from "@foraeldreintra/api-client";
import { privateRead, privateWrite, sessionPath, home } from "./state";

import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { downloadResult, downloadOne, extractFile } from "./attachments";
import { compare, type Snapshot } from "./snapshot";
import { hash } from "../../foraeldreintra-api-client/src/content";

async function credentials() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new IntraError(
      "INPUT_REQUIRED",
      "Use an interactive terminal or --credentials-file with a mode-600 JSON file.",
    );
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const username = await rl.question("Username: ");
  rl.close();
  process.stderr.write("Password: ");
  const password = await new Promise<string>((resolve, reject) => {
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", read);
      process.stderr.write("\n");
    };
    const read = (chunk: Buffer) => {
      for (const c of chunk.toString()) {
        if (c === "\x03") {
          done();
          reject(new IntraError("CANCELLED", "Login cancelled."));
          return;
        }
        if (c === "\r" || c === "\n") {
          done();
          resolve(value);
          return;
        }
        if (c === "\x7f" || c === "\b") value = value.slice(0, -1);
        else if (c >= " ") value += c;
      }
    };
    process.stdin.on("data", read);
  });
  return { username, password };
}
async function main() {
  const options: Record<string, { type: "string" | "boolean" }> = {};
  for (const name of [
    "school",
    "credentials-file",
    "child",
    "week",
    "start",
    "end",
    "thread-id",
    "cursor",
    "max-pages",
    "save",
    "areas",
    "out",
    "from",
    "id",
    "file",
    "name",
    "group",
    "person-id",
  ])
    options[name] = { type: "string" };
  for (const name of ["help", "download", "metadata-only"])
    options[name] = { type: "boolean" };
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options,
  });
  const str = (key: string) =>
    typeof values[key] === "string" ? (values[key] as string) : undefined;
  const command = positionals[0];
  if (!command || values.help || command === "help") {
    console.log(`ForældreIntra read-only CLI — JSON output

login --school=https://SCHOOL.m.skoleintra.dk [--credentials-file=FILE]
login-info --school=URL
children
home --child=ID
news pins|news|archive --child=ID
messages threads|thread --child=ID [--thread-id=ID] [--cursor=ID] [--max-pages=20]
weekly --child=ID [--week=40-2026]
calendar events|activities|schedule|holidays --child=ID --start=YYYY-MM-DD --end=YYYY-MM-DD
documents school|class --child=ID [--max-pages=100]
contactbook|diaries|links --child=ID
forms open|closed --child=ID
photos albums|archives --child=ID
contacts --child=ID --name=NAME [--group=students|staff] [--person-id=ID]
sync --child=ID [--areas=pins,news,messages,weekly,documents/class] [--week=40-2026]
     [--start=YYYY-MM-DD --end=YYYY-MM-DD] [--metadata-only]
attachments download --child=ID --from=RESULT.json --id=ATTACHMENT_ID [--out=DIR]
attachments extract --file=FILE [--out=DIR]

Content options: --download (save originals), --save=FILE (private JSON instead of stdout).
Sync downloads attachments unless --metadata-only. First sync establishes a quiet baseline.
No automatic contact harvesting. No send/reply/edit/submit/delete commands.`);
    return;
  }
  if (command === "login-info") {
    if (!str("school"))
      throw new IntraError("INPUT_REQUIRED", "login-info requires --school.");
    console.log(
      JSON.stringify(
        await new IntraClient(str("school")!).inspectLogin(),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "login") {
    if (!str("school"))
      throw new IntraError("INPUT_REQUIRED", "login requires --school.");
    const client = new IntraClient(str("school")!);
    const creds = str("credentials-file")
      ? await privateRead(str("credentials-file")!)
      : await credentials();
    if (
      typeof creds.username !== "string" ||
      typeof creds.password !== "string" ||
      !creds.username ||
      !creds.password
    )
      throw new IntraError(
        "INPUT_REQUIRED",
        "Credentials require nonempty username and password strings.",
      );
    const result = await client.login(creds.username, creds.password);
    await privateWrite(sessionPath, {
      version: 1,
      school: client.origin,
      jar: await client.jar.serialize(),
      authenticatedAt: new Date().toISOString(),
    });
    console.log(
      JSON.stringify(
        {
          status: "authenticated",
          school: client.origin,
          children: result.children,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "attachments" && positionals[1] === "extract") {
    if (!str("file"))
      throw new IntraError(
        "INPUT_REQUIRED",
        "attachments extract requires --file.",
      );
    const extracted = await extractFile(
      str("file")!,
      str("out") ?? join(home, "extracted"),
    );
    console.log(JSON.stringify(extracted, null, 2));
    if ("extractionComplete" in extracted && !extracted.extractionComplete)
      process.exitCode = 2;
    return;
  }
  const contentCommands = [
    "children",
    "contacts",
    "home",
    "news",
    "messages",
    "weekly",
    "calendar",
    "documents",
    "contactbook",
    "diaries",
    "links",
    "forms",
    "photos",
    "sync",
    "attachments",
  ];
  if (!contentCommands.includes(command))
    throw new IntraError("UNKNOWN_COMMAND", "Unknown command; use --help.");
  if (command !== "children" && !str("child"))
    throw new IntraError(
      "CHILD_REQUIRED",
      "Select a child explicitly with --child=ID. Run children to list IDs.",
    );
  let session;
  try {
    session = await privateRead(sessionPath);
  } catch (e) {
    if (e instanceof IntraError) throw e;
    throw new IntraError(
      "LOGIN_REQUIRED",
      "No readable session; run login first.",
    );
  }
  const client = new IntraClient(
    session.school,
    await CookieJar.deserialize(session.jar),
  );
  try {
    const children = await client.children();
    if (command === "children") {
      console.log(JSON.stringify({ children }, null, 2));
      return;
    }
    const child = children.find((c) => c.id === str("child"));
    if (!child)
      throw new IntraError(
        "CHILD_NOT_FOUND",
        "Selected child is not available on this account.",
      );
    const reader = new ContentReader(client, child);
    const pages = Number(str("max-pages") ?? "100");
    if (!Number.isInteger(pages) || pages < 1 || pages > 1000)
      throw new IntraError("INVALID_LIMIT", "--max-pages must be 1–1000.");
    const output = async (data: any) => {
      if (str("save")) {
        await privateWrite(str("save")!, data);
        console.log(JSON.stringify({ saved: str("save") }));
      } else console.log(JSON.stringify(data, null, 2));
    };
    const read = async (area: string): Promise<Result> => {
      if (area === "home") return reader.news("home", pages);
      if (["pins", "news", "archive"].includes(area))
        return reader.news(area as any, pages);
      if (area === "messages")
        return reader.messages({
          maxPages: pages,
          cursor: str("cursor"),
          thread: str("thread-id"),
        });
      if (area === "weekly") return reader.weekly(str("week"));
      if (
        [
          "calendar",
          "calendar/all",
          "calendar/activities",
          "calendar/schedule",
          "calendar/holidays",
        ].includes(area)
      ) {
        if (!str("start") || !str("end"))
          throw new IntraError(
            "INPUT_REQUIRED",
            "Calendar requires --start and --end.",
          );
        return reader.calendar(
          str("start")!,
          str("end")!,
          (area.split("/")[1] ?? "all") as any,
        );
      }
      if (area === "documents/school" || area === "documents/class")
        return reader.documents(
          area.split("/")[1] as "school" | "class",
          pages,
        );
      if (
        [
          "contactbook",
          "diaries",
          "forms/open",
          "forms/closed",
          "photos/albums",
          "photos/archives",
          "links",
        ].includes(area)
      )
        return reader.simple(area as any);
      throw new IntraError("UNKNOWN_AREA", "Unknown content area. Use --help.");
    };
    if (command === "contacts") {
      const group = str("group") ?? "students";
      if (!["students", "staff"].includes(group))
        throw new IntraError(
          "INPUT_REQUIRED",
          "--group must be students or staff.",
        );
      await output(
        await reader.contact(
          str("name") ?? "",
          group as "students" | "staff",
          str("person-id"),
        ),
      );
      return;
    }
    if (command === "attachments") {
      if (positionals[1] !== "download" || !str("from") || !str("id"))
        throw new IntraError(
          "INPUT_REQUIRED",
          "Use attachments download --from=RESULT.json --id=ID --child=ID.",
        );
      const result = await privateRead(str("from")!);
      if (result.school !== client.origin || result.child?.id !== child.id)
        throw new IntraError(
          "SCOPE_MISMATCH",
          "Attachment manifest belongs to another school or child.",
        );
      const a = result.items
        ?.flatMap((i: any) => i.attachments ?? [])
        .find((a: any) => a.id === str("id"));
      if (!a)
        throw new IntraError(
          "NOT_FOUND",
          "Attachment ID not present in the saved result.",
        );
      await output(
        await downloadOne(
          client,
          child,
          a,
          str("out") ?? join(home, "attachments"),
        ),
      );
      return;
    }
    if (command === "sync") {
      if (!str("start") && !str("end")) {
        const now = new Date(),
          year =
            now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
        values.start = `${year}-08-01`;
        values.end = `${year + 1}-08-01`;
      }
      const areas = (
        str("areas") ??
        "home,pins,news,archive,messages,weekly,calendar,calendar/holidays,documents/school,documents/class,contactbook,diaries,forms/open,forms/closed,photos/albums,photos/archives,links"
      ).split(",");
      const reports: any[] = [];
      for (const area of areas) {
        const scope = JSON.stringify({
          school: client.origin,
          child: child.id,
          area,
          week: str("week") ?? null,
          start: str("start") ?? null,
          end: str("end") ?? null,
          attachments: !values["metadata-only"],
          cursor: str("cursor") ?? null,
          thread: str("thread-id") ?? null,
        });
        const path = join(home, "snapshots", hash(scope) + ".json"),
          lock = path + ".lock";
        await mkdir(join(home, "snapshots"), { recursive: true, mode: 0o700 });
        try {
          await mkdir(lock, { mode: 0o700 });
        } catch {
          throw new IntraError(
            "SYNC_LOCKED",
            "Another sync is active; if it crashed, remove its .lock directory under snapshots.",
          );
        }
        try {
          let result = await read(area);
          if (!values["metadata-only"])
            result = await downloadResult(
              client,
              result,
              str("out") ?? join(home, "attachments"),
            );
          else
            result.warnings.push(
              "Attachment bytes were not checked for changes.",
            );
          if (!result.complete || result.status === "unsupported") {
            reports.push({
              area,
              status: result.status,
              updated: false,
              warnings: result.warnings,
              attachmentErrors: result.items.flatMap((item) =>
                item.attachments
                  .filter((a) => a.error)
                  .map((a) => ({ itemId: item.id, ...a })),
              ),
            });
            process.exitCode = 2;
            continue;
          }
          let previous: Snapshot | undefined;
          try {
            previous = await privateRead(path);
          } catch (e: any) {
            if (e.code !== "ENOENT") throw e;
          }
          const { snapshot, changes } = compare(result, scope, previous);
          await privateWrite(path, snapshot);
          reports.push({
            area,
            status: result.status,
            updated: true,
            ...changes,
            warnings: result.warnings,
          });
        } catch (e) {
          reports.push({
            area,
            updated: false,
            error:
              e instanceof IntraError
                ? { code: e.code, message: e.message }
                : {
                    code: "SYNC_ERROR",
                    message: "Could not read or update this snapshot.",
                  },
          });
          process.exitCode = 2;
        } finally {
          await rm(lock, { recursive: true, force: true });
        }
      }
      await output({ school: client.origin, child, reports });
      return;
    }
    const sub = positionals[1];
    let area = command;
    if (command === "news") {
      if (!["pins", "news", "archive"].includes(sub ?? ""))
        throw new IntraError(
          "INPUT_REQUIRED",
          "Use news pins, news news, or news archive.",
        );
      area = sub!;
    }
    if (command === "messages" && sub && !["threads", "thread"].includes(sub))
      throw new IntraError(
        "UNKNOWN_COMMAND",
        "Use messages threads or messages thread.",
      );
    if (
      ["home", "weekly", "contactbook", "diaries", "links"].includes(command) &&
      sub
    )
      throw new IntraError("UNKNOWN_COMMAND", "Unexpected subcommand.");
    if (command === "messages" && sub === "thread" && !str("thread-id"))
      throw new IntraError(
        "INPUT_REQUIRED",
        "messages thread requires --thread-id.",
      );
    if (command === "calendar") {
      if (
        !["events", "activities", "schedule", "holidays"].includes(
          sub ?? "events",
        )
      )
        throw new IntraError("INPUT_REQUIRED", "Unknown calendar view.");
      area = "calendar/" + (sub === "events" || !sub ? "all" : sub);
    }
    if (["documents", "forms", "photos"].includes(command))
      area = command + "/" + sub;
    let result = await read(area);
    if (values.download)
      result = await downloadResult(
        client,
        result,
        str("out") ?? join(home, "attachments"),
      );
    await output(result);
    if (!result.complete || result.status === "unsupported")
      process.exitCode = 2;
  } finally {
    await privateWrite(sessionPath, {
      ...session,
      jar: await client.jar.serialize(),
    });
  }
}
main().catch((error) => {
  const known = error instanceof IntraError;
  console.error(
    JSON.stringify({
      error: {
        code: known ? error.code : "LOCAL_ERROR",
        message: known
          ? error.message
          : "Operation failed. Check local files, arguments, and configuration.",
      },
    }),
  );
  process.exitCode = 1;
});
