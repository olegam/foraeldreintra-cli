import { load } from "cheerio";
import { createHash } from "node:crypto";
import { IntraError, type Child, type IntraClient } from "./index";

export interface Attachment {
  id: string;
  name: string;
  url: string;
  mediaType: string | null;
  size: number | null;
  sha256?: string;
  localPath?: string;
  error?: string;
}
export interface Item {
  id: string;
  kind: string;
  childId: string;
  sourceUrl: string;
  title: string;
  createdAt: string | null;
  modifiedAt: string | null;
  timezone: string;
  content: { text: string; html: string };
  attachments: Attachment[];
  data: Record<string, any>;
}
export interface Result {
  schemaVersion: 1;
  school: string;
  child: Child;
  area: string;
  sourceUrl: string;
  observedAt: string;
  status: "ok" | "empty" | "unsupported";
  complete: boolean;
  items: Item[];
  warnings: string[];
  next: string | null;
}
export const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export const cleanText = (html: string) => {
  const $ = load(html);
  $("script,style").remove();
  $("br").replaceWith("\n");
  $("p,div,li,tr,h1,h2,h3").append("\n");
  return $.text()
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};
export function safeHtml(html: string) {
  const $ = load(html, {}, false);
  $("script,style,form,input,button,iframe,object,embed").remove();
  $("*").each((_, el) => {
    for (const k of Object.keys("attribs" in el ? el.attribs : {}))
      if (/^on|^data-|^style$/i.test(k)) $(el).removeAttr(k);
  });
  return $.html();
}
export function settings(html: string, name: string): any {
  const $ = load(html),
    value = $(`[data-clientlogic-settings-${name.toLowerCase()}]`).attr(
      `data-clientlogic-settings-${name.toLowerCase()}`,
    );
  if (!value)
    throw new IntraError(
      "UNRECOGNIZED_PAGE",
      `Missing ${name} data; the school page may have changed.`,
    );
  try {
    return JSON.parse(value);
  } catch {
    throw new IntraError("UNRECOGNIZED_PAGE", "Invalid page settings.");
  }
}
// Parse only a JSON argument, never evaluate page JavaScript.
export function initSettings(html: string, name: string): any {
  const marker = `NewSkoleIntra.${name}.Init(`,
    start = html.indexOf(marker);
  if (start < 0)
    throw new IntraError(
      "UNRECOGNIZED_PAGE",
      `Missing ${name} initialization.`,
    );
  let quoted = false,
    escape = false,
    depth = 0;
  const begin = start + marker.length;
  for (let i = begin; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(begin, i + 1));
      } catch {
        break;
      }
    }
  }
  throw new IntraError("UNRECOGNIZED_PAGE", "Invalid initialization data.");
}
export function dateText(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(
    /(\d{1,2})\.\s*(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)\.?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/i,
  );
  if (!m) return null;
  const month =
    [
      "jan",
      "feb",
      "mar",
      "apr",
      "maj",
      "jun",
      "jul",
      "aug",
      "sep",
      "okt",
      "nov",
      "dec",
    ].indexOf(m[2]!.toLowerCase()) + 1;
  const day = `${m[3]}-${String(month).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return m[4] ? `${day}T${m[4].padStart(2, "0")}:${m[5]}:00` : day;
}
export function attachment(
  url: string,
  name: string,
  base: string,
): Attachment {
  const u = new URL(url, base);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
    throw new IntraError("UNSAFE_ATTACHMENT", "Invalid attachment URL.");
  const fileName = u.searchParams.get("fileName");
  if (fileName && name.includes("?fileName=")) name = fileName;
  const ext = ((fileName ?? name).split(".").pop() ?? "").toLowerCase();
  const types: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return {
    id: hash(
      u.origin +
        u.pathname +
        (u.pathname === "/file/ckeditorfiles/view/image"
          ? JSON.stringify([
              u.searchParams.get("fileName"),
              u.searchParams.get("userUnifiedId"),
            ])
          : u.pathname.startsWith("/file/newsfrom/")
            ? (u.searchParams.get("newsId") ?? "")
            : ""),
    ).slice(0, 24),
    name,
    url: u.href,
    mediaType: types[ext] ?? null,
    size: null,
  };
}
export function htmlAttachments(html: string, base: string): Attachment[] {
  const $ = load(html);
  const found = new Map<string, Attachment>();
  $(".sk-attachments-list a[href],a[href]").each((_, el) => {
    const href = $(el).attr("href")!;
    if (
      $(el).closest(".sk-attachments-list").length ||
      /\.(pdf|docx?|xlsx?|png|jpe?g|gif|webp)(?:\?|$)/i.test(href)
    ) {
      const a = attachment(
        href,
        $(el).text().trim() || decodeURIComponent(href.split("/").at(-1)!),
        base,
      );
      found.set(a.id, a);
    }
  });
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src")!;
    if (!src.startsWith("data:")) {
      const a = attachment(
        src,
        $(el).attr("alt") || decodeURIComponent(src.split("/").at(-1)!),
        base,
      );
      found.set(a.id, a);
    }
  });
  return [...found.values()];
}
function requireArray(v: any): any[] {
  if (!Array.isArray(v))
    throw new IntraError(
      "UNRECOGNIZED_RESPONSE",
      "Expected a list from the school.",
    );
  return v;
}
function json(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    throw new IntraError(
      "UNRECOGNIZED_RESPONSE",
      "Expected JSON from the school.",
    );
  }
}
export class ContentReader {
  constructor(
    readonly client: IntraClient,
    readonly child: Child,
  ) {}
  private get base() {
    return this.client.origin + this.child.path;
  }
  private result(
    area: string,
    url: string,
    items: Item[],
    warnings: string[] = [],
    complete = true,
    next: string | null = null,
  ): Result {
    return {
      schemaVersion: 1,
      school: this.client.origin,
      child: this.child,
      area,
      sourceUrl: url,
      observedAt: new Date().toISOString(),
      status: items.length ? "ok" : "empty",
      complete,
      items,
      warnings,
      next,
    };
  }
  private item(
    kind: string,
    id: string,
    url: string,
    title: string,
    html = "",
    data: Record<string, any> = {},
  ): Item {
    const body = safeHtml(html);
    return {
      id: `${kind}:${id}`,
      kind,
      childId: this.child.id,
      sourceUrl: url,
      title,
      createdAt: null,
      modifiedAt: null,
      timezone: "Europe/Copenhagen",
      content: { text: cleanText(body), html: body },
      attachments: [],
      data,
    };
  }
  private async get(url: string) {
    return (await this.client.readPage(url, this.child)).html;
  }
  async news(
    area: "pins" | "news" | "archive" | "home",
    maxPages = 20,
  ): Promise<Result> {
    const url =
      area === "home"
        ? this.base + "/Index"
        : area === "archive"
          ? this.base + "/news/news_archive/1"
          : this.base + "/news/" + area;
    const items = new Map<string, Item>(),
      seen = new Set<string>();
    let next: string | null = url;
    let pages = 0;
    let feedHtml: string | undefined;
    let feedMore = false;
    const pagings: Record<string, string> = {};
    while (next && pages < maxPages) {
      const current: string = next;
      seen.add(current);
      pages++;
      const html = feedHtml ?? (await this.get(current)),
        $ = load(html);
      const rows = $(".sk-news-item");
      for (const el of rows.toArray()) {
        const row = $(el);
        let id = row.attr("data-feed-item-id");
        const type = row.attr("data-feed-item-type") ?? "news";
        if (!id)
          id = new URL(current).pathname.match(/\/news\/news\/(\d+)$/)?.[1];
        if (!id)
          throw new IntraError(
            "UNRECOGNIZED_PAGE",
            "News item has no stable ID.",
          );
        pagings[type] = id;
        const body = row
          .find(".sk-user-input")
          .map((_, e) => $(e).html())
          .get()
          .join("\n");
        const category = row
          .find(".sk-news-item-content > .h-fnt-bd")
          .text()
          .trim();
        const title =
          row.find(".sk-news-item-content > .h-fnt-bd + div").text().trim() ||
          cleanText(body).split("\n")[0] ||
          type;
        const kind =
          type === "skoleintra-pin"
            ? "pin"
            : type === "skoleintra-news-from"
              ? "news"
              : type;
        const source =
          kind === "pin"
            ? `${this.base}/news/pins`
            : kind === "news"
              ? `${this.base}/news/news/${id}`
              : current;
        const item = this.item(kind, id, source, title, body, {
          category: category || null,
          author:
            row.find(".sk-news-item-author > span").first().text().trim() ||
            null,
        });
        const times = row
          .find(".sk-news-item-header .sk-news-item-timestamp")
          .text();
        item.createdAt = dateText(times);
        item.modifiedAt = dateText(times.split(/opdateret/i)[1]);
        item.data.expiresAt = dateText(
          row.find(".sk-news-item-footer .sk-news-item-timestamp").text(),
        );
        item.attachments = htmlAttachments(
          row.find(".sk-news-item-content").html() ?? "",
          current,
        );
        items.set(item.id, item);
      }
      // News overview contains links only; fetch each full article.
      for (const el of $(".sk-l-content a[href]").toArray()) {
        const href = $(el).attr("href")!;
        if (/\/news\/news\/\d+$/.test(href)) {
          const detail = new URL(href, current).href;
          if (!seen.has(detail)) {
            seen.add(detail);
            const result = await this.newsDetail(detail);
            for (const item of result) items.set(item.id, item);
          }
        }
      }
      next = null;
      const links = $(
        "a[rel=next],.ccl-pager a,.pagination a,.sk-pager a",
      ).toArray();
      for (const el of links) {
        const href = $(el).attr("href");
        if (!href) continue;
        const target: string = new URL(href, current).href;
        if (
          !seen.has(target) &&
          (/næste|next|›|»/i.test($(el).text()) || $(el).attr("rel") === "next")
        ) {
          next = target;
          break;
        }
      }
      if (area === "home") {
        if (pages === 1) feedMore = $("#ShowMorePostsLink").length > 0;
        if (feedMore) {
          const more = await this.client.readFeed(this.child, pagings);
          feedHtml = more.View;
          feedMore = more.HasMoreItems;
          const f = load(feedHtml);
          const incoming = f(".sk-news-item");
          if (feedMore && !incoming.length)
            throw new IntraError(
              "PAGINATION_STALLED",
              "News feed did not advance.",
            );
          if (incoming.length) {
            const changes = incoming
              .toArray()
              .some(
                (e) =>
                  pagings[f(e).attr("data-feed-item-type") ?? ""] !==
                  f(e).attr("data-feed-item-id"),
              );
            if (!changes)
              throw new IntraError(
                "PAGINATION_STALLED",
                "News cursor repeated.",
              );
            next = url;
          }
        }
      }
      if (!items.size && !$(".sk-no-data-feedback").length)
        throw new IntraError(
          "UNRECOGNIZED_PAGE",
          "News page has no recognized content or empty marker.",
        );
    }
    return this.result(
      "news/" + area,
      url,
      [...items.values()],
      next ? ["Page limit reached."] : [],
      !next,
      next,
    );
  }
  private async newsDetail(url: string): Promise<Item[]> {
    const html = await this.get(url),
      $ = load(html),
      row = $(".sk-news-item").first();
    if (!row.length)
      throw new IntraError("UNRECOGNIZED_PAGE", "News detail missing.");
    const id = new URL(url).pathname.split("/").at(-1)!;
    const body = row.find(".sk-user-input").html() ?? "";
    const item = this.item(
      "news",
      id,
      url,
      row.find(".sk-news-item-content > .h-fnt-bd + div").text().trim() ||
        cleanText(body).split("\n")[0] ||
        id,
      body,
      {
        category: row.find(".sk-news-item-content > .h-fnt-bd").text().trim(),
        author: row.find(".sk-news-item-author > span").first().text().trim(),
      },
    );
    const times = row.find(".sk-news-item-timestamp").first().text();
    item.createdAt = dateText(times);
    item.modifiedAt = dateText(times.split(/opdateret/i)[1]);
    item.attachments = htmlAttachments(
      row.find(".sk-news-item-content").html() ?? "",
      url,
    );
    return [item];
  }
  async messages(
    options: {
      maxPages?: number;
      cursor?: string;
      thread?: string;
      details?: boolean;
    } = {},
  ): Promise<Result> {
    const url = this.base + "/messages/conversations",
      html = await this.get(url),
      config = settings(html, "messageconversationswitharchivefunctionality"),
      d = config.DataProviderSettings;
    let conversations = requireArray(config.Conversations),
      cursor = options.cursor,
      complete = false;
    const all = new Map<string, any>();
    let pages = 0;
    if (cursor)
      conversations = await this.messagePage(d.GetNewConversationsUrl, {
        takeFromRootMessageId: cursor,
        searchRequest: "",
        filter: "",
      });
    while (true) {
      for (const c of conversations)
        all.set(c.ThreadId || String(c.LatestMessageId), c);
      pages++;
      if (!conversations.length) {
        complete = true;
        break;
      }
      cursor = String(conversations.at(-1).LatestMessageId);
      if (pages >= (options.maxPages ?? 20)) break;
      const more = await this.messagePage(d.GetNewConversationsUrl, {
        takeFromRootMessageId: cursor,
        searchRequest: "",
        filter: "",
      });
      if (
        more.length &&
        more.every((c) => all.has(c.ThreadId || String(c.LatestMessageId)))
      )
        throw new IntraError(
          "PAGINATION_STALLED",
          "Message pagination did not advance.",
        );
      conversations = more;
    }
    const items: Item[] = [];
    for (const c of all.values()) {
      const id = c.ThreadId || String(c.LatestMessageId);
      if (options.thread && id !== options.thread) continue;
      const item = this.item("thread", id, url, c.Subject, "", {
        messageCount: c.MessagesCount,
        latestMessageId: c.LatestMessageId,
        participants: c.ThreadParticipantsString,
        messages: [],
      });
      if (options.details !== false) {
        let messages: any[];
        if (c.ThreadId) {
          messages = await this.messagePage(
            d.LoadMessagesForSelectedConversationUrl,
            {
              threadId: c.ThreadId,
              takeFromRootMessageId: String(c.LatestMessageId),
              takeToMessageId: "0",
              searchRequest: "",
            },
          );
          // Expand headers identifies replies omitted by a server-side detail limit.
          const headers = await this.messagePage(d.ExpandThreadMessagesUrl, {
            threadId: c.ThreadId,
            latestMessageId: String(c.LatestMessageId),
          });
          const known = new Set(messages.map((m) => m.Id));
          for (const h of headers) {
            if (!known.has(h.MessageId)) {
              const extra = json(
                await this.get(
                  this.query(d.GetMessageForThreadlessConversationUrl, {
                    messageId: String(h.MessageId),
                  }),
                ),
              );
              if (extra) {
                messages.push(extra);
                known.add(extra.Id);
              }
            }
          }
          if (messages.length < c.MessagesCount)
            throw new IntraError(
              "INCOMPLETE_THREAD",
              "School returned fewer messages than the thread count.",
            );
        } else {
          const single = json(
            await this.get(
              this.query(d.GetMessageForThreadlessConversationUrl, {
                messageId: String(c.LatestMessageId),
              }),
            ),
          );
          messages = single ? [single] : [];
        }
        item.data.messages = messages.map((m) => this.message(m, url));
        item.data.messages.sort(
          (a: Item, b: Item) =>
            (a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
            a.id.localeCompare(b.id),
        );
        item.content = {
          text: item.data.messages
            .map((m: Item) => m.content.text)
            .join("\n\n"),
          html: item.data.messages.map((m: Item) => m.content.html).join("\n"),
        };
        item.attachments = item.data.messages.flatMap(
          (m: Item) => m.attachments,
        );
        item.createdAt = item.data.messages[0]?.createdAt ?? null;
      }
      items.push(item);
    }
    if (options.thread && !items.length)
      throw new IntraError(
        "NOT_FOUND",
        "Thread not found within the fetched history.",
      );
    return this.result(
      "messages",
      url,
      items,
      complete ? [] : ["Page limit reached; use next cursor."],
      complete,
      complete ? null : (cursor ?? null),
    );
  }
  private message(m: any, url: string): Item {
    if (!m || !m.Id || typeof m.BaseText !== "string")
      throw new IntraError(
        "UNRECOGNIZED_RESPONSE",
        "Unexpected message shape.",
      );
    if (m.BlockedFeedback)
      throw new IntraError(
        "ACCESS_DENIED",
        "The school blocked a message body.",
      );
    const i = this.item("message", String(m.Id), url, m.Subject, m.BaseText, {
      sender: m.SenderName,
      quotedHtml: safeHtml(m.PreviousMessagesText ?? ""),
      sentAtText: m.SentReceivedDateText,
      additionalLinkUrl: m.AdditionalLinkUrl || null,
    });
    i.createdAt = dateText(m.SentReceivedDateText);
    i.attachments = htmlAttachments(
      m.BaseText + (m.PreviousMessagesText ?? ""),
      url,
    );
    if (m.AttachmentsLinks) {
      for (const a of requireArray(m.AttachmentsLinks)) {
        const href = a.Url ?? a.Uri ?? a.Href ?? a.HrefAttributeValue;
        const name = a.Text ?? a.FileName ?? a.Name;
        if (!href)
          throw new IntraError(
            "UNRECOGNIZED_ATTACHMENT",
            "Message attachment URL missing.",
          );
        i.attachments.push(attachment(href, name ?? "attachment", url));
      }
    }
    return i;
  }
  private query(url: string, params: Record<string, string>) {
    const u = new URL(url, this.client.origin);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.href;
  }
  private async messagePage(url: string, params: Record<string, string>) {
    return requireArray(json(await this.get(this.query(url, params))));
  }
  async weekly(week?: string): Promise<Result> {
    const listUrl = this.base + "item/weeklyplansandhomework/list";
    const list = await this.get(listUrl),
      $ = load(list);
    let links = $(".sk-weekly-plans-list-container a[href]")
      .map((_, e) => new URL($(e).attr("href")!, listUrl).href)
      .get();
    if (week) {
      if (!/^(?:[1-9]|[1-4]\d|5[0-3])-\d{4}$/.test(week))
        throw new IntraError(
          "INVALID_WEEK",
          "Use ISO week-year, e.g. 40-2026.",
        );
      const sample = links[0];
      if (!sample)
        throw new IntraError(
          "UNSUPPORTED",
          "No weekly-plan URL template found.",
        );
      links = [sample.replace(/\d{1,2}-\d{4}$/, week)];
    }
    if (!links.length && !$(".sk-no-data-feedback").length)
      throw new IntraError("UNRECOGNIZED_PAGE", "Weekly-plan list changed.");
    const items: Item[] = [];
    for (const url of links) {
      const html = await this.get(url);
      const v = settings(html, "weeklyplansapp").SelectedPlan;
      if (!v || !Array.isArray(v.DailyPlans))
        throw new IntraError("UNRECOGNIZED_PAGE", "Weekly plan data missing.");
      const days = [v.GeneralPlan, ...v.DailyPlans].filter(Boolean);
      const plans = days.flatMap((day: any) =>
        (day.LessonPlans ?? []).map((p: any) => ({
          id: String(p.WeeklyPlanId),
          day: day.Day ?? null,
          date: day.Date ?? null,
          subject: p.Subject,
          content: {
            text: cleanText(p.Content ?? ""),
            html: safeHtml(p.Content ?? ""),
          },
          link: p.Link ?? null,
          snapshots: p.Snapshots ?? [],
          attachments: [
            ...(p.Attachments ?? []).map((a: any) =>
              attachment(a.Uri, a.FileName, url),
            ),
            ...htmlAttachments(p.Content ?? "", url),
          ],
        })),
      );
      const i = this.item(
        "weekly-plan",
        v.FormattedWeek,
        url,
        `Uge ${v.FormattedWeek}`,
        plans.map((p: any) => p.content.html).join("\n"),
        {
          week: v.FormattedWeek,
          classOrGroup: v.ClassOrGroup,
          plans,
          schedule: v.DailyPlans.map((d: any) => ({
            date: d.Date,
            day: d.Day,
            lessons: d.Schedule ?? [],
          })),
        },
      );
      i.attachments = [
        ...plans.flatMap((p: any) => p.attachments),
        ...(v.Attachments ?? []).map((a: any) =>
          attachment(a.Uri, a.FileName, url),
        ),
      ];
      if (plans.length || i.attachments.length) items.push(i);
    }
    return this.result(
      "weekly",
      week ? links[0]! : listUrl,
      items,
      week
        ? []
        : [
            "The list contains recent weeks only. Use --week to read earlier weeks.",
          ],
      true,
    );
  }
  async calendar(
    start: string,
    end: string,
    kind: "all" | "activities" | "schedule" | "holidays" = "all",
  ): Promise<Result> {
    if (kind === "holidays") {
      const result = await this.simple("holidays");
      result.area = "calendar/holidays";
      result.warnings.push(
        "Holidays page is scoped to school years displayed by the school, not the requested event range.",
      );
      return result;
    }
    const a = Date.parse(start),
      b = Date.parse(end);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(end) ||
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      new Date(a).toISOString().slice(0, 10) !== start ||
      new Date(b).toISOString().slice(0, 10) !== end ||
      a >= b ||
      b - a > 366 * 86400000
    )
      throw new IntraError(
        "INVALID_RANGE",
        "Use --start and --end YYYY-MM-DD, increasing and at most 366 days apart. End is exclusive.",
      );
    const url = this.base + "/calendar/myCalendar",
      html = await this.get(url),
      config = initSettings(html, "Calendar"),
      items = new Map<string, Item>();
    for (const source of requireArray(config.CalendarModel?.EventSources)) {
      if (
        (kind === "schedule" && source.Name !== "Lessons") ||
        (kind === "activities" && source.Name !== "Activity")
      )
        continue;
      if (source.RequestType !== "GET")
        throw new IntraError(
          "UNSUPPORTED",
          "Calendar source does not use a verified GET operation.",
        );
      for (const e of requireArray(
        json(
          await this.get(
            this.query(source.Url, {
              start: String(a / 1000),
              end: String(b / 1000),
            }),
          ),
        ),
      )) {
        if (e.originalId === undefined)
          throw new IntraError(
            "UNRECOGNIZED_RESPONSE",
            "Stable calendar ID missing.",
          );
        const data = Object.fromEntries(
          Object.entries(e).filter(
            ([k]) =>
              ![
                "id",
                "originalId",
                "startDate",
                "endDate",
                "description",
                "Attachments",
              ].includes(k),
          ),
        );
        const ms = (v: string) => {
          const m = v?.match(/\/Date\((-?\d+)/);
          return m ? new Date(Number(m[1])).toISOString() : null;
        };
        data.start = ms(e.startDate) ?? e.start;
        data.end = ms(e.endDate) ?? e.end;
        data.cancelled =
          typeof e.cancelled === "boolean"
            ? e.cancelled
            : typeof e.IsCancelled === "boolean"
              ? e.IsCancelled
              : null;
        const i = this.item(
          "calendar",
          `${e.type}:${e.originalId}`,
          url,
          e.title,
          e.description ?? "",
          data,
        );
        i.attachments = (e.Attachments ?? []).map((x: any) =>
          attachment(x.Uri ?? x.Url, x.FileName ?? x.Text ?? "attachment", url),
        );
        items.set(i.id, i);
      }
    }
    return this.result(
      "calendar/" + kind,
      url,
      [...items.values()],
      [
        "Range: " +
          start +
          " through " +
          end +
          " (exclusive). Missing events are not automatically treated as cancelled.",
      ],
    );
  }
  async documents(scope: "school" | "class", maxPages = 100): Promise<Result> {
    const url = this.base + "/documents/" + scope,
      queue = [url],
      seen = new Set<string>(),
      items: Item[] = [];
    while (queue.length && seen.size < maxPages) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const html = await this.get(current),
        $ = load(html);
      if (!$(".sk-documents-list").length)
        throw new IntraError(
          "UNRECOGNIZED_PAGE",
          "Document folder not recognized.",
        );
      for (const el of $(".sk-documents-content-row").toArray()) {
        const row = $(el),
          a = row.find("a.sk-documents-row-clickable-area"),
          folder = a.attr("data-content-link"),
          href = folder ?? a.attr("href");
        if (!href || href.startsWith("javascript:"))
          throw new IntraError("UNRECOGNIZED_PAGE", "Document link missing.");
        const target: string = new URL(href, current).href;
        const title = row.find(".sk-documents-document-title").text().trim();
        const id =
          row.find("[data-documentid]").attr("data-documentid") ??
          new URL(target).searchParams.get("folderName") ??
          target;
        const i = this.item(
          folder ? "folder" : "document",
          `${scope}:${id}`,
          target,
          title,
          "",
          {
            scope,
            parentUrl: current,
            author:
              row.find(".sk-documents-owner-column").text().trim() || null,
          },
        );
        i.modifiedAt = dateText(row.find(".sk-documents-date-column").text());
        if (folder) queue.push(target);
        else i.attachments = [attachment(target, title, current)];
        items.push(i);
      }
    }
    return this.result(
      "documents/" + scope,
      url,
      items,
      queue.length ? ["Folder limit reached."] : [],
      !queue.length,
      queue[0] ?? null,
    );
  }
  async contact(
    query: string,
    group: "students" | "staff" = "students",
    personId?: string,
  ): Promise<Result> {
    if (query.trim().length < 2 && !personId)
      throw new IntraError(
        "INPUT_REQUIRED",
        "Provide at least two characters for a targeted contact lookup.",
      );
    const url = this.base + "/contacts/" + group + "/cards",
      html = await this.get(url),
      $ = load(html),
      config = settings(html, "usercardpage");
    const options = $(`[id="${config.ContactDropdownClientId}"] option[value]`)
      .toArray()
      .map((el) => ({
        name: $(el).attr("title") ?? $(el).text().trim(),
        url: $(el).attr("value")!,
      }))
      .filter((x) => /\/\d+$/.test(x.url));
    const matches = options.filter((x) =>
      personId
        ? x.url.split("/").at(-1) === personId
        : x.name
            .toLocaleLowerCase("da")
            .includes(query.toLocaleLowerCase("da")),
    );
    if (matches.length !== 1)
      return this.result(
        "contacts/" + group,
        url,
        matches.map((x) =>
          this.item(
            "contact-match",
            group + ":" + x.url.split("/").at(-1),
            new URL(x.url, url).href,
            x.name,
            "",
            { personId: x.url.split("/").at(-1) },
          ),
        ),
        matches.length
          ? [
              "Multiple matches. Repeat with --person-id. No contact details have been fetched.",
            ]
          : ["No matching contact."],
      );
    const match = matches[0]!,
      target = new URL(match.url, url).href,
      detail = await this.get(target),
      d = load(detail);
    if (!d(".sk-labeledtext").length)
      throw new IntraError(
        "UNRECOGNIZED_PAGE",
        "Contact detail format changed.",
      );
    d("script,style,img,input").remove();
    const item = this.item(
      "contact",
      group + ":" + match.url.split("/").at(-1),
      target,
      d(".sk-contact-person-name .sk-labeledtext-value").first().text().trim(),
      d("body").html() ?? "",
      {
        fields: d(".sk-labeledtext")
          .map((_, e) => ({
            label: d(e).find(".sk-labeledtext-caption").text().trim(),
            value: d(e).find(".sk-labeledtext-value").text().trim(),
          }))
          .get(),
      },
    );
    return this.result("contacts/" + group, target, [item]);
  }
  async simple(
    area:
      | "contactbook"
      | "diaries"
      | "forms/open"
      | "forms/closed"
      | "photos/albums"
      | "photos/archives"
      | "links"
      | "holidays",
  ): Promise<Result> {
    const routes = {
      holidays: "/calendar/holidays",
      contactbook: "/contactbook/notes",
      diaries: "/diaries/list",
      "forms/open": "/forms/open",
      "forms/closed": "/forms/closed",
      "photos/albums": "/photos/albums",
      "photos/archives": "/photos/archives",
      links: "/ExternalLinks/all",
    };
    const url = this.base + routes[area],
      html = await this.get(url),
      $ = load(html);
    if (area.startsWith("forms/")) {
      const prop = $("[data-vue-component-data]").attr(
        "data-vue-component-data",
      );
      if (!prop)
        throw new IntraError("UNRECOGNIZED_PAGE", "Form data missing.");
      const rows = requireArray(json(prop).Items);
      if (!rows.length) return this.result(area, url, []);
      // Retain all supplied fields, but flag unverified nonempty form contracts.
      const items = rows.map((f: any) =>
        this.item(
          "form",
          String(f.Id ?? hash(JSON.stringify(f))),
          url,
          String(f.Name ?? f.Title ?? "Form"),
          "",
          { status: area.split("/")[1], source: f },
        ),
      );
      return {
        ...this.result(
          area,
          url,
          items,
          ["Nonempty form detail links are not yet verified."],
          false,
        ),
        status: "unsupported",
      };
    }
    const main = $(".sk-l-content");
    if (!main.length)
      throw new IntraError("UNRECOGNIZED_PAGE", "Content region missing.");
    const empty = main.find(".sk-no-data-feedback").text().trim();
    if (empty) return this.result(area, url, [], [empty]);
    if (area === "links") {
      const container = main.find(".sk-links-container");
      if (!container.length)
        throw new IntraError("UNRECOGNIZED_PAGE", "Link container missing.");
      const items: Item[] = [];
      container.find("a[href]").each((_, el) => {
        const href = $(el).attr("href")!;
        if (href && !/^javascript:|^#/i.test(href)) {
          const i = this.item(
            "link",
            hash(href).slice(0, 24),
            url,
            $(el).text().trim(),
            "",
            { url: href },
          );
          items.push(i);
        }
      });
      return this.result(area, url, items);
    }
    // Do not turn a new/unverified populated layout into an empty result.
    main
      .find(
        "script,style,nav,form,[data-clientlogic-settings-genericfeedback],[role=dialog]",
      )
      .remove();
    const item = this.item(
      area,
      hash(url).slice(0, 24),
      url,
      $("title").text(),
      main.html() ?? "",
    );
    item.attachments = htmlAttachments(item.content.html, url);
    return {
      ...this.result(
        area,
        url,
        [item],
        [
          "Populated layout needs a verified item/detail parser. Full page content is retained, but completeness is not claimed.",
        ],
        false,
      ),
      status: "unsupported",
    };
  }
}
