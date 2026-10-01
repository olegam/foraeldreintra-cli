import { test, expect } from "bun:test";
import { IntraClient, CookieJar, IntraError } from "./index";
import { ContentReader, dateText, initSettings, attachment } from "./content";
import { assertReadUrl, assertAttachmentUrl } from "./routes";
const school = "https://school.m.skoleintra.dk",
  child = { id: "12", name: "Anna", path: "/parent/12/Anna" };
function client(fn: (url: URL, init: RequestInit) => Response) {
  return new IntraClient(school, new CookieJar(), ((u: any, i: any) =>
    Promise.resolve(fn(new URL(u), i))) as typeof fetch);
}
const attr = (v: any) =>
  JSON.stringify(v).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
test("only enumerated read routes under explicitly selected child are accepted", () => {
  for (const path of [
    "/news/pins/create",
    "/news/subscribe/1",
    "/news/removefromfrontpage/1",
    "/messages/changemessagestatus",
    "/forms/open?submit=true",
    "/documents/class/../class/delete",
    "/news/pins?returnUrl=https://evil.test",
  ])
    expect(() =>
      assertReadUrl(school + child.path + path, school, child),
    ).toThrow();
  expect(() =>
    assertReadUrl(school + "/parent/13/Bo/news/pins", school, child),
  ).toThrow();
  expect(() =>
    assertReadUrl(school + child.path + "/news/pins", school, child),
  ).not.toThrow();
});
test("attachment guard rejects credentials, cross-origin, traversal and actions", () => {
  for (const u of [
    "https://evil.test/a.pdf",
    school + "/parent/12/Anna/news/pins/delete/1",
    school + "/Faelles/%2e%2e%2fsecret.pdf",
    school + "/file/messageattach/a.jpg?delete=1",
  ])
    expect(() => assertAttachmentUrl(u, school, child)).toThrow();
  expect(() =>
    assertAttachmentUrl(
      school + "/file/messageattach/folder/a.pdf",
      school,
      child,
    ),
  ).not.toThrow();
});
test("content redirects into authentication report expired session without leaking cookies", async () => {
  const r = new ContentReader(
    client(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "/Account/IdpLogin" },
        }),
    ),
    child,
  );
  await expect(r.news("pins")).rejects.toMatchObject({
    code: "LOGIN_REQUIRED",
  });
});
test("Danish timestamps retain local precision and never invent missing years", () => {
  expect(dateText("Torsdag, 1. okt. 2026 09:05")).toBe("2026-10-01T09:05:00");
  expect(dateText("1. okt. 2026")).toBe("2026-10-01");
  expect(dateText("1. okt.")).toBeNull();
});
test("embedded initialization is parsed as JSON, never evaluated", () => {
  expect(
    initSettings(
      'NewSkoleIntra.Calendar.Init({"x":"} and \\\"","a":{"b":1}});',
      "Calendar",
    ).a.b,
  ).toBe(1);
  expect(() =>
    initSettings(
      "NewSkoleIntra.Calendar.Init({x:process.exit()});",
      "Calendar",
    ),
  ).toThrow();
});
test("messages preserve all replies and omit unread state from content", async () => {
  const config = {
    Conversations: [
      { ThreadId: "t", Subject: "Topic", LatestMessageId: 2, MessagesCount: 2 },
    ],
    DataProviderSettings: {
      GetNewConversationsUrl:
        child.path + "/messages/conversations/getconversationsbypageindex",
      LoadMessagesForSelectedConversationUrl:
        child.path +
        "/messages/conversations/loadmessagesforselectedconversation",
      ExpandThreadMessagesUrl:
        child.path + "/messages/conversations/expandmessagethread",
    },
  };
  const r = new ContentReader(
    client((u) => {
      if (u.pathname.endsWith("/conversations"))
        return new Response(
          `<div data-clientlogic-settings-messageconversationswitharchivefunctionality="${attr(config)}"></div>`,
        );
      if (u.pathname.endsWith("getconversationsbypageindex"))
        return Response.json([]);
      if (u.pathname.endsWith("expandmessagethread"))
        return Response.json([{ MessageId: 1 }, { MessageId: 2 }]);
      return Response.json([
        {
          Id: 2,
          Subject: "Topic",
          BaseText: "<p>Reply</p>",
          SenderName: "B",
          SentReceivedDateText: "2. okt. 2026 10:00",
          ShowUnreadIndication: true,
          AttachmentsLinks: [
            {
              HrefAttributeValue: "/file/messageattach/f/a.pdf",
              Text: "a.pdf",
            },
          ],
        },
        {
          Id: 1,
          Subject: "Topic",
          BaseText: "<p>Original</p>",
          SenderName: "A",
          SentReceivedDateText: "1. okt. 2026 10:00",
        },
      ]);
    }),
    child,
  );
  const result = await r.messages();
  expect(result.complete).toBe(true);
  expect(result.items[0]!.data.messages).toHaveLength(2);
  expect(result.items[0]!.content.text).toContain("Reply");
  expect(result.items[0]!.attachments[0]!.name).toBe("a.pdf");
  expect(JSON.stringify(result)).not.toContain("ShowUnread");
});
test("calendar identity uses stable original ID, not per-request UUID", async () => {
  let n = 0;
  const r = new ContentReader(
    client((u) =>
      u.pathname.endsWith("myCalendar")
        ? new Response(
            "NewSkoleIntra.Calendar.Init(" +
              JSON.stringify({
                CalendarModel: {
                  EventSources: [
                    {
                      Name: "Activity",
                      RequestType: "GET",
                      Url: child.path + "/calendareventsource/ActivitiesEvents",
                    },
                  ],
                },
              }) +
              ");",
          )
        : Response.json([
            {
              id: String(++n),
              originalId: 42,
              type: 0,
              title: "Event",
              startDate: "/Date(1793888100000)/",
              endDate: "/Date(1793898900000)/",
            },
          ]),
    ),
    child,
  );
  const a = await r.calendar("2026-11-01", "2026-12-01"),
    b = await r.calendar("2026-11-01", "2026-12-01");
  expect(a.items).toEqual(b.items);
  expect(a.items[0]!.id).toBe("calendar:0:42");
});
test("empty areas require explicit evidence and forms embedded empty list is recognized", async () => {
  const empty = new ContentReader(
    client(
      () =>
        new Response(
          '<div class="sk-l-content"><div class="sk-no-data-feedback">Ingen noter</div></div>',
        ),
    ),
    child,
  );
  expect((await empty.simple("contactbook")).status).toBe("empty");
  const changed = new ContentReader(
    client(() => new Response("<div>New layout</div>")),
    child,
  );
  await expect(changed.simple("contactbook")).rejects.toMatchObject({
    code: "UNRECOGNIZED_PAGE",
  });
  const forms = new ContentReader(
    client(
      () =>
        new Response(
          '<div data-vue-component-data="{&quot;Items&quot;:[]}"></div>',
        ),
    ),
    child,
  );
  expect((await forms.simple("forms/open")).status).toBe("empty");
});
test("weekly plan ignores read receipts but keeps daily content and every attachment", async () => {
  const plan = {
    FormattedWeek: "40-2026",
    GeneralPlan: {
      LessonPlans: [
        {
          WeeklyPlanId: 2,
          Content: "<p>General</p>",
          Attachments: [
            {
              Uri:
                child.path +
                "item/weeklyplansandhomework/weeklyplansattachment/2/0/a.docx",
              FileName: "a.docx",
            },
          ],
        },
      ],
    },
    DailyPlans: [
      {
        Date: "2026-09-30",
        Day: "Onsdag",
        LessonPlans: [
          { WeeklyPlanId: 3, Subject: { Title: "Dansk" }, Content: "Homework" },
        ],
        Schedule: [{ TimeString: "08:00 - 09:00" }],
      },
    ],
    HistoryData: [{ UserName: "Private read receipt", Date: "today" }],
  };
  const r = new ContentReader(
    client(
      (u) =>
        new Response(
          u.pathname.endsWith("/list")
            ? `<ul class="sk-weekly-plans-list-container"><li><a href="${child.path}item/weeklyplansandhomework/item/class/40-2026">week</a></li></ul>`
            : `<div data-clientlogic-settings-weeklyplansapp="${attr({ SelectedPlan: plan })}"></div>`,
        ),
    ),
    child,
  );
  const result = await r.weekly("40-2026");
  expect(result.items[0]!.attachments).toHaveLength(1);
  expect(result.items[0]!.data.plans).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain("Private read receipt");
});
test("home feed permits exactly its verified read POST and paginates to exhaustion", async () => {
  const row = (id: number) =>
    `<div class="sk-news-item" data-feed-item-type="skoleintra-pin" data-feed-item-id="${id}"><div class="sk-news-item-content"><div class="sk-user-input">Post ${id}</div></div></div>`;
  let post = 0;
  const r = new ContentReader(
    client((u, i) => {
      if (u.pathname.endsWith("Index"))
        return new Response(
          row(2) + '<button id="ShowMorePostsLink"></button>',
        );
      expect(i.method).toBe("POST");
      expect(u.pathname).toBe(child.path + "/newsitems/showmore");
      post++;
      return Response.json({ View: row(1), HasMoreItems: false });
    }),
    child,
  );
  const result = await r.news("home");
  expect(result.items.map((i) => i.id)).toEqual(["pin:2", "pin:1"]);
  expect(result.complete).toBe(true);
  expect(post).toBe(1);
});
test("holiday page does not mistake school-feed birthdays for holidays", async () => {
  const r = new ContentReader(
    client((u) => {
      expect(u.pathname).toBe(child.path + "/calendar/holidays");
      return new Response(
        '<div class="sk-l-content"><div class="sk-no-data-feedback">Ingen feriedage</div></div>',
      );
    }),
    child,
  );
  const result = await r.calendar("2026-10-01", "2026-12-01", "holidays");
  expect(result.status).toBe("empty");
  expect(result.items).toEqual([]);
});
test("access-denied HTML must not become an empty-area result", async () => {
  const r = new ContentReader(
    client(
      () =>
        new Response(
          '<div class="sk-l-content"><div class="sk-no-data-feedback">Du har ikke adgang til dette område.</div></div>',
        ),
    ),
    child,
  );
  await expect(r.simple("contactbook")).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});
test("contact lookup retrieves one card and refuses to harvest ambiguous matches", async () => {
  const markup = `<div data-clientlogic-settings-usercardpage="${attr({ ContactDropdownClientId: "people" })}"></div><select id="people"><option value="${child.path}/contacts/students/12">Anna One</option><option value="${child.path}/contacts/students/13">Anna Two</option></select>`;
  let details = 0;
  const r = new ContentReader(
    client((u) => {
      if (u.pathname.endsWith("/cards")) return new Response(markup);
      details++;
      expect(u.pathname.endsWith("/12")).toBe(true);
      return new Response(
        '<div class="sk-labeledtext sk-contact-person-name"><span class="sk-labeledtext-caption">Name</span><span class="sk-labeledtext-value">Anna One</span></div>',
      );
    }),
    child,
  );
  const ambiguous = await r.contact("Anna");
  expect(ambiguous.items.length).toBe(2);
  expect(details).toBe(0);
  const chosen = await r.contact("", "students", "12");
  expect(chosen.items[0]!.title).toBe("Anna One");
  expect(details).toBe(1);
});
test("document download follows the observed same-school file redirect", async () => {
  let step = 0;
  const c = client((u) => {
    step++;
    return step === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "/file/parent/school/99/folder/a.docx" },
        })
      : new Response(new Uint8Array([80, 75, 3, 4]), {
          headers: { "content-type": "application/octet-stream" },
        });
  });
  const result = await c.download(
    school + child.path + "/documents/class/4",
    child,
  );
  expect(result.bytes.length).toBe(4);
  expect(step).toBe(2);
});
test("editor and news attachment identities retain required query keys without collisions", () => {
  const editor = school + "/file/ckeditorfiles/view/image";
  const a = attachment(
      editor + "?fileName=a.docx&userUnifiedId=1",
      "a.docx",
      school,
    ),
    b = attachment(
      editor + "?fileName=b.docx&userUnifiedId=1",
      "b.docx",
      school,
    );
  expect(a.id).not.toBe(b.id);
  expect(a.id).toBe(
    attachment(editor + "?userUnifiedId=1&fileName=a.docx", "a.docx", school)
      .id,
  );
  expect(() => assertAttachmentUrl(a.url, school, child)).not.toThrow();
  expect(() =>
    assertAttachmentUrl(
      editor + "?fileName=..%2Fsecret.docx&userUnifiedId=1",
      school,
      child,
    ),
  ).toThrow();
  expect(() =>
    assertAttachmentUrl(a.url + "&delete=1", school, child),
  ).toThrow();
  const news = school + "/file/newsfrom/a.pdf";
  expect(() =>
    assertAttachmentUrl(news + "?newsId=7", school, child),
  ).not.toThrow();
  expect(attachment(news + "?newsId=7", "a.pdf", school).id).not.toBe(
    attachment(news + "?newsId=8", "a.pdf", school).id,
  );
  expect(() =>
    assertAttachmentUrl(
      school + "/file/newsfrom/..%2Fsecret.pdf?newsId=7",
      school,
      child,
    ),
  ).toThrow();
});
