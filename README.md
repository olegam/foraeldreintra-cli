# ForældreIntra CLI

Read-only, browser-free ForældreIntra CLI for personal scripts and agents. Uses username/password login once, then reuses a private cookie session. Built with Bun in the same API-client/CLI workspace structure as the sibling Aula CLI.

The school URL is configurable. Child IDs, names, class names, calendar feeds, and message endpoints are discovered from authenticated pages. The implementation has been live-tested against Johannesskolen; other schools using the same SkoleIntra mobile portal are supported by the same adapters but have not been individually tested.

## Install and login

```sh
bun install
bun run login --school=https://johannesskolen.m.skoleintra.dk
bun run cli children
```

Enter the username and hidden password in your terminal. The password is never saved or printed. No browser or Playwright is needed. For another school, supply its HTTPS `*.skoleintra.dk` entry URL.

To use the command directly:

```sh
cd packages/foraeldreintra-cli
bun link
```

Then run `foraeldreintra-cli …` instead of `bun run cli …`.

## Read content

Replace `CHILD_ID` with an ID returned by `children`. Every content command requires an explicit child; the CLI never chooses the first child for you.

```sh
bun run cli home --child=CHILD_ID
bun run cli news pins --child=CHILD_ID
bun run cli news news --child=CHILD_ID
bun run cli news archive --child=CHILD_ID
bun run cli messages threads --child=CHILD_ID
bun run cli messages thread --child=CHILD_ID --thread-id=THREAD_ID
bun run cli weekly --child=CHILD_ID --week=40-2026
bun run cli calendar events --child=CHILD_ID --start=2026-10-01 --end=2026-11-01
bun run cli calendar activities --child=CHILD_ID --start=2026-10-01 --end=2027-01-01
bun run cli calendar schedule --child=CHILD_ID --start=2026-10-01 --end=2026-10-08
bun run cli calendar holidays --child=CHILD_ID --start=2026-10-01 --end=2027-08-01
bun run cli documents school --child=CHILD_ID
bun run cli documents class --child=CHILD_ID
bun run cli contactbook --child=CHILD_ID
bun run cli diaries --child=CHILD_ID
bun run cli forms open --child=CHILD_ID
bun run cli forms closed --child=CHILD_ID
bun run cli photos albums --child=CHILD_ID
bun run cli photos archives --child=CHILD_ID
bun run cli links --child=CHILD_ID
```

Message commands fetch complete bodies and replies, following conversation history until exhausted or `--max-pages` is reached. A limited result includes `next`; pass it as `--cursor` to continue. The default page/folder limit is 100, configurable up to 1,000. Documents traverse subfolders. Home-feed pagination uses the site's verified read-only POST operation.

`weekly` without `--week` reads the site's recent list, currently five weeks; use `--week=33-2026` to fetch older plans. It returns general notes, daily subject entries, the lesson schedule, and attachment metadata. It excludes other parents' read receipts.

Calendar ranges use an exclusive end date and are limited to 366 days. Event IDs use the stable source `originalId`, not generated display UUIDs. Explicit source cancellation fields are retained when provided; a missing event is never assumed cancelled. Holidays come from the separate school-year holidays page, not the school-event feed (which also includes birthdays).

Contact lookup is on demand only:

```sh
bun run cli contacts --child=CHILD_ID --name=Anna
bun run cli contacts --child=CHILD_ID --group=staff --name=Teacher
bun run cli contacts --child=CHILD_ID --person-id=PERSON_ID
```

Only a uniquely matched card's details are fetched. Ambiguous names return matching names/IDs so you can choose. Contacts are excluded from sync; the CLI does not retain the directory.

## JSON output and errors

Each content result contains `schemaVersion`, `school`, `child`, `area`, `sourceUrl`, `observedAt`, `status`, `complete`, `items`, `warnings`, and `next`.

Items contain a stable namespaced `id`, `kind`, `childId`, `sourceUrl`, `title`, `createdAt`, `modifiedAt`, `timezone`, full `content.text` and `content.html`, attachment metadata, and domain-specific `data`. Source timestamps are nullable; missing dates are never replaced with fetch time. Danish display dates retain their available precision, with local times interpreted in `Europe/Copenhagen`; calendar epoch dates are returned in UTC.

Add `--save=/path/result.json` to write private JSON instead of printing content. Errors are JSON on stderr; credentials, cookie values, raw login responses, and SAML assertions are suppressed.

- Exit `0`: requested scope read successfully, including a verified empty result.
- Exit `1`: invalid input, expired login, access denial, transport/parser error, or a failed single attachment operation.
- Exit `2`: incomplete/unsupported content, a page/folder limit, attachment failure in a batch, incomplete embedded-image extraction, or a failed sync area. Available content is still returned; sync does not replace that area's baseline.

## Attachments and visual content

Metadata reads require Bun only. Download validation and extraction additionally use Python 3, Pillow for images, and Poppler's `pdftotext` for PDFs. Legacy `.doc` files are also preserved and text-checked using macOS `textutil`; this optional format currently requires macOS. These tools are already available in the development environment. Install them in your chosen environment when deploying elsewhere; missing validators produce an explicit error. There is no OCR dependency or background browser.

```sh
bun run cli weekly --child=CHILD_ID --week=40-2026 --download --save=week.json
bun run cli attachments download --child=CHILD_ID --from=week.json --id=ATTACHMENT_ID
bun run cli attachments extract --file=/path/to/downloaded.docx
```

Downloads retain originals under `~/.foraeldreintra-cli/attachments`, named by SHA-256 with a verified extension. They return byte size, detected media type, checksum, and local path. Files are limited to 25 MiB, use mode `600`, and accept only verified same-school attachment routes. `--out` selects a mode-`700` directory without symlink ancestors. Unsupported hosts, routes, formats, corrupt files, and missing files are explicit failures.

DOCX extraction preserves text and **all embedded media** under `~/.foraeldreintra-cli/extracted`, including image paths and checksums. Corrupt/unreadable embedded images are individually flagged. PDF extraction preserves the original and returns text. Images remain available for visual reading. Every extraction returns `visualReviewRequired: true`: text and embedded media do not reproduce page layout, and the CLI does not claim to have understood image contents. Open/render originals when layout carries meaning. Week 40's live DOCX contains eight embedded images.

## Detect new content and edits

```sh
bun run cli sync --child=CHILD_ID
bun run cli sync --child=CHILD_ID --areas=messages,weekly --week=40-2026
bun run cli sync --child=CHILD_ID --metadata-only
```

Default sync covers home, posts, news/archive, complete message history, recent weekly plans, calendar/holidays, school/class documents, contact book, diaries, forms, photos, and external links. Its default calendar interval is the current school year, August 1 through the following August 1; override with `--start` and `--end`.

The first successful scan establishes a quiet baseline. Later scans report:

- `added`: newly discovered records whose known creation time follows the previous scan.
- `changed`: previously observed IDs whose substantive content or attachment bytes changed, including old message threads and their replies.
- `discovered`: previously unseen historical/unknown-age records. Being unread never makes something new. Date-only records cannot establish a same-day creation time.
- `missing`: not seen in this scan; retained in history and never automatically called deleted/cancelled.

Sync downloads and hashes attachments by default, detecting replaced files even if their URLs stay the same. `--metadata-only` skips that work and explicitly warns that attachment bytes were not checked. These two modes have separate baselines. Each area/child/school/date-range/week selection has its own snapshot; scans are locked and files replaced atomically. Failed or incomplete areas keep their last good baseline. Sync records local history from when you begin using it; it cannot recover overwritten historical versions from the school.

Recent-week scans do not revisit every older week. Run a separate `--week` sync for older plans you need to keep monitoring. No notifications are sent by the CLI.

## Coverage limits

The current account has empty contact book, diaries, forms, photo albums/archives, holidays, and news archive. Their empty states are verified. **Populated contact-book, diary, form, photo, and holiday adapters are not complete**: available page/model content is returned with `status: "unsupported"`, `complete: false`, and exit `2`, preserving the baseline. Populated archive pagination has not been live-tested. These cases need populated, sanitized fixtures before full support can be claimed. Unknown layouts never become a successful empty result.

Other login providers, custom domains, attachment hosts, and school-specific layouts may require additional adapters. This release deliberately limits requests to observed read operations. There is no send, reply, sign-up, absence change, delete, or form-submit command. Opening content can affect the site's read status, as authorized; explicit mark-read/write operations are excluded.

## Session and local state

- `~/.foraeldreintra-cli/session.json`: mode-`600` cookie jar; no stored password.
- `~/.foraeldreintra-cli/snapshots/`: private content baselines.
- `~/.foraeldreintra-cli/attachments/` and `extracted/`: private originals and extracted media.
- `FORAELDREINTRA_CLI_HOME`: override the state directory.

A valid saved identity-provider session can complete the SAML renewal exchange automatically. If authentication actually expires, reading returns `LOGIN_REQUIRED`; run `login` again. School credentials are only submitted to the selected school. The observed shared identity provider is allowlisted; cross-origin credential replay is blocked.

For noninteractive login, `--credentials-file=/private/file.json` accepts `{"username":"…","password":"…"}`. It must be owned by you, mode `600`, and not a symlink. Keep it outside the repository. Local state contains private school information and authentication secrets; it is permission-protected, not encrypted.

## Development

```sh
bun run check
bun run build
bun dist/index.js --help
```

The build includes the DOCX helper alongside `dist/index.js`. Tests use synthetic data; private discovery artifacts are ignored under `.private/`. See [endpoint discovery notes](docs/discovery.md) for verified contracts and remaining work.
