import { IntraError, type Child } from "./index";
const reads: [RegExp, string[]][] = [
  [/^\/contacts\/(students|staff)\/(cards|\d+)$/i, []],
  [/^\/Index$/i, []],
  [/^\/news\/(pins|news|news\/\d+|news_archive\/\d+)$/i, ["page", "pageIndex"]],
  [/^\/messages\/conversations$/i, []],
  [
    /^\/messages\/conversations\/(getconversationsbypageindex|getinitailconversations|expandmessagethread|loadmessagesforselectedconversation|getmessageforthreadlessconversation)$/i,
    [
      "takeFromRootMessageId",
      "takeToMessageId",
      "threadId",
      "latestMessageId",
      "messageId",
      "searchRequest",
      "filter",
    ],
  ],
  [
    /^item\/weeklyplansandhomework\/(list|(?:frontpage\/)?item\/class\/\d{1,2}-\d{4})$/i,
    [],
  ],
  [/^\/calendar\/(myCalendar(?:\/today)?|activities|schedule|holidays)$/i, []],
  [
    /^\/calendareventsource\/(LessonsEvents|ActivitiesEvents|SchoolEvents)$/i,
    ["className", "start", "end"],
  ],
  [
    /^\/documents\/(school|class)(?:\/(list|folder))?$/i,
    ["folderName", "sortColumn", "sortOrder"],
  ],
  [
    /^\/(contactbook\/notes|diaries\/list|forms\/(open|closed)|photos\/(albums|archives)|ExternalLinks\/all)$/i,
    [],
  ],
];
export function assertReadUrl(
  value: string,
  origin: string,
  child: Child,
): URL {
  const u = new URL(value, origin);
  if (
    u.origin !== origin ||
    u.username ||
    u.password ||
    !u.pathname.startsWith(child.path)
  )
    throw new IntraError(
      "READ_ONLY_GUARD",
      "Request is outside the selected child and school.",
    );
  const tail = u.pathname.slice(child.path.length);
  const rule = reads.find(([pattern]) => pattern.test(tail));
  if (!rule || [...u.searchParams.keys()].some((k) => !rule[1].includes(k)))
    throw new IntraError(
      "READ_ONLY_GUARD",
      "This route is not a verified read operation.",
    );
  return u;
}
export function assertAttachmentUrl(
  value: string,
  origin: string,
  child: Child,
): URL {
  const u = new URL(value, origin);
  if (u.origin !== origin || u.username || u.password || u.hash)
    throw new IntraError(
      "UNSAFE_ATTACHMENT",
      "Only verified same-school attachment URLs are supported.",
    );
  if (u.pathname === "/file/ckeditorfiles/view/image") {
    const keys = [...u.searchParams.keys()],
      file = u.searchParams.get("fileName"),
      owner = u.searchParams.get("userUnifiedId");
    if (
      keys.length === 2 &&
      keys.includes("fileName") &&
      keys.includes("userUnifiedId") &&
      file &&
      !/[\\/\0]/.test(file) &&
      file !== "." &&
      file !== ".." &&
      /\.(pdf|docx?|jpe?g|png|gif|webp)$/i.test(file) &&
      owner &&
      /^\d+$/.test(owner)
    )
      return u;
    throw new IntraError(
      "UNSAFE_ATTACHMENT",
      "Invalid editor attachment parameters.",
    );
  }
  if (
    /^\/file\/newsfrom\/[^/]+\.(pdf|docx?|jpe?g|png|gif|webp)$/i.test(
      decodeURIComponent(u.pathname),
    ) &&
    [...u.searchParams.keys()].length === 1 &&
    /^\d+$/.test(u.searchParams.get("newsId") ?? "")
  )
    return u;
  if (u.search)
    throw new IntraError(
      "UNSAFE_ATTACHMENT",
      "Unexpected attachment query parameters.",
    );
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    throw new IntraError("UNSAFE_ATTACHMENT", "Invalid attachment path.");
  }
  if (
    path.includes("\\") ||
    path.split("/").includes("..") ||
    path.includes("\0")
  )
    throw new IntraError("UNSAFE_ATTACHMENT", "Unsafe attachment path.");
  const own = u.pathname.startsWith(child.path)
    ? u.pathname.slice(child.path.length)
    : "";
  if (
    !/^\/Faelles\/.+\.(pdf|docx?|jpe?g|png|gif|webp)$/i.test(path) &&
    !/^\/file\/(?:messageattach|newsfrom|parent\/school\/\d+)\/.+\.(pdf|docx?|jpe?g|png|gif|webp)$/i.test(
      path,
    ) &&
    !/^item\/weeklyplansandhomework\/weeklyplansattachment\/\d+\/\d+\/[^/]+$/i.test(
      own,
    ) &&
    !/^\/documents\/(school|class)\/\d+$/i.test(own)
  )
    throw new IntraError(
      "UNSAFE_ATTACHMENT",
      "Attachment route has not been verified.",
    );
  return u;
}
