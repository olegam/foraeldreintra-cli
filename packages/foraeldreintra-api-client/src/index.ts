import { load } from "cheerio";
import { CookieJar } from "tough-cookie";
import { assertReadUrl, assertAttachmentUrl } from "./routes";

export class IntraError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function schoolOrigin(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new IntraError("INVALID_SCHOOL", "Provide an HTTPS school URL.");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    !u.hostname.endsWith(".skoleintra.dk")
  )
    throw new IntraError(
      "INVALID_SCHOOL",
      "Expected an HTTPS school host under skoleintra.dk.",
    );
  return u.origin;
}
export interface Child {
  id: string;
  name: string;
  path: string;
}
export function childrenFromHtml(html: string, origin: string): Child[] {
  const $ = load(html);
  const found = new Map<string, Child>();
  $("a[href]").each((_, el) => {
    let u: URL;
    try {
      u = new URL($(el).attr("href")!, origin);
    } catch {
      return;
    }
    if (u.origin !== origin) return;
    const m = u.pathname.match(/^\/parent\/(\d+)\/([^/]+)(?:\/|$)/i);
    if (!m || /item$/i.test(m[2]!)) return;
    found.set(m[1]!, {
      id: m[1]!,
      name: decodeURIComponent(m[2]!),
      path: `/parent/${m[1]}/${m[2]}`,
    });
  });
  return [...found.values()];
}
export function loginForm(html: string, url: string) {
  const $ = load(html);
  const form = $('input[type="password"]').closest("form");
  if (form.length !== 1)
    throw new IntraError(
      "UNSUPPORTED_LOGIN",
      "No supported password login form found.",
    );
  if ((form.attr("method") ?? "").toLowerCase() !== "post")
    throw new IntraError("UNSUPPORTED_LOGIN", "Expected a POST login form.");
  const fields = new URLSearchParams();
  form.find('input[type="hidden"][name]').each((_, el) => {
    fields.append($(el).attr("name")!, $(el).attr("value") ?? "");
  });
  const username = form.find('input[name="UserName"]').attr("name");
  const password = form.find('input[type="password"]').attr("name");
  if (!username || !password || !fields.has("__RequestVerificationToken"))
    throw new IntraError("UNSUPPORTED_LOGIN", "Login form has changed.");
  return {
    action: new URL(form.attr("action") ?? url, url).href,
    fields,
    username,
    password,
  };
}
export class IntraClient {
  readonly origin: string;
  constructor(
    school: string,
    readonly jar = new CookieJar(),
    private fetcher: typeof fetch = fetch,
  ) {
    this.origin = schoolOrigin(school);
  }
  private url(input: string) {
    const u = new URL(input, this.origin);
    if (
      ![this.origin, "https://idp.m.skoleintra.dk"].includes(u.origin) ||
      u.username ||
      u.password
    )
      throw new IntraError(
        "UNSAFE_REDIRECT",
        "A cross-origin request was blocked; this login flow needs further verification.",
      );
    return u;
  }
  // POST is limited to authentication and the verified read-only home-feed operation.
  private async request(
    input: string,
    body?: URLSearchParams,
    guard?: (url: string) => unknown,
  ): Promise<{ html: string; url: string }> {
    let u = this.url(input);
    let method = body ? "POST" : "GET";
    for (let redirects = 0; redirects < 12; redirects++) {
      guard?.(u.href);
      const headers: Record<string, string> = {
        Accept: "text/html, application/json",
        Cookie: await this.jar.getCookieString(u.href),
      };
      if (guard) headers["X-Requested-With"] = "XMLHttpRequest";
      if (body) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        headers.Origin = this.origin;
        headers.Referer = this.origin + "/";
      }
      let res: Response;
      try {
        res = await this.fetcher(u, {
          method,
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        throw new IntraError(
          "NETWORK_ERROR",
          "School request failed or timed out.",
        );
      }
      for (const cookie of res.headers.getSetCookie())
        await this.jar.setCookie(cookie, u.href);
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        if (!location)
          throw new IntraError(
            "HTTP_ERROR",
            "Redirect did not contain a destination.",
          );
        const next = this.url(new URL(location, u).href);
        if (body && [307, 308].includes(res.status) && next.origin !== u.origin)
          throw new IntraError(
            "UNSAFE_REDIRECT",
            "Cross-origin POST replay blocked.",
          );
        if (
          guard &&
          (next.origin !== this.origin ||
            /\/account\/|\/sso\//i.test(next.pathname))
        )
          throw new IntraError(
            "LOGIN_REQUIRED",
            "Session expired; run login again.",
          );
        u = next;
        if ([301, 302, 303].includes(res.status)) {
          body = undefined;
          method = "GET";
        }
        continue;
      }
      if (res.status === 401)
        throw new IntraError(
          "LOGIN_REQUIRED",
          "Session expired; run login again.",
        );
      if (res.status === 403)
        throw new IntraError("ACCESS_DENIED", "The school denied access.");
      if (!res.ok)
        throw new IntraError(
          "HTTP_ERROR",
          `School returned HTTP ${res.status}.`,
        );
      const bytes = await limitedBody(res, 12 * 1024 * 1024);
      return { html: new TextDecoder().decode(bytes), url: u.href };
    }
    throw new IntraError("REDIRECT_LOOP", "Too many login redirects.");
  }
  async readFeed(child: Child, pagings: Record<string, string>) {
    if (
      Object.entries(pagings).some(
        ([k, v]) => !/^[-a-z0-9]+$/i.test(k) || !/^\d+$/.test(v),
      )
    )
      throw new IntraError("INVALID_CURSOR", "Invalid news cursor.");
    const url = this.origin + child.path + "/newsitems/showmore";
    const page = await this.request(
      url,
      new URLSearchParams({ pagings: JSON.stringify(pagings) }),
      (u) => {
        if (u !== url)
          throw new IntraError(
            "READ_ONLY_GUARD",
            "Unexpected news-feed redirect.",
          );
      },
    );
    if (
      load(page.html)('input[type="password"],input[name="SAMLResponse"]')
        .length
    )
      throw new IntraError(
        "LOGIN_REQUIRED",
        "Session expired; run login again.",
      );
    try {
      const result = JSON.parse(page.html);
      if (
        typeof result.View !== "string" ||
        typeof result.HasMoreItems !== "boolean"
      )
        throw Error();
      return result as { View: string; HasMoreItems: boolean };
    } catch {
      throw new IntraError(
        "UNRECOGNIZED_RESPONSE",
        "Unexpected news feed response.",
      );
    }
  }
  async readPage(url: string, child: Child) {
    const page = await this.request(url, undefined, (u) =>
      assertReadUrl(u, this.origin, child),
    );
    const $ = load(page.html);
    if ($('input[type="password"],input[name="SAMLResponse"]').length)
      throw new IntraError(
        "LOGIN_REQUIRED",
        "Session expired; run login again.",
      );
    if (
      /adgang nægtet|ingen adgang|ikke.{0,30}adgang|access denied|not authorized/i.test(
        $(".sk-no-access,.ccl-feedback-error,.sk-no-data-feedback").text(),
      )
    )
      throw new IntraError(
        "ACCESS_DENIED",
        "The school denied access to this area.",
      );
    return page;
  }
  async download(url: string, child: Child) {
    let u = assertAttachmentUrl(url, this.origin, child);
    for (let n = 0; n < 6; n++) {
      let r: Response;
      try {
        r = await this.fetcher(u, {
          headers: { Cookie: await this.jar.getCookieString(u.href) },
          redirect: "manual",
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        throw new IntraError("ATTACHMENT_ERROR", "Attachment request failed.");
      }
      for (const c of r.headers.getSetCookie())
        await this.jar.setCookie(c, u.href);
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        const next = new URL(r.headers.get("location") ?? "", u);
        if (
          next.origin !== this.origin ||
          /\/account\/|\/sso\//i.test(next.pathname)
        )
          throw new IntraError(
            "LOGIN_REQUIRED",
            "Attachment needs a new login or uses an unsupported redirect.",
          );
        u = assertAttachmentUrl(next.href, this.origin, child);
        continue;
      }
      if (!r.ok)
        throw new IntraError(
          r.status === 403 ? "ACCESS_DENIED" : "ATTACHMENT_ERROR",
          `Attachment returned HTTP ${r.status}.`,
        );
      const bytes = await limitedBody(r, 25 * 1024 * 1024);
      const contentType = r.headers.get("content-type")?.split(";")[0] ?? "";
      if (contentType === "text/html")
        throw new IntraError(
          "UNREADABLE_ATTACHMENT",
          "Attachment returned an HTML page instead of a file.",
        );
      return { bytes, contentType };
    }
    throw new IntraError(
      "ATTACHMENT_ERROR",
      "Attachment redirect limit exceeded.",
    );
  }
  async inspectLogin() {
    const page = await this.request("/");
    const form = loginForm(page.html, page.url);
    if (this.url(form.action).origin !== this.origin)
      throw new IntraError(
        "UNSAFE_REDIRECT",
        "Password submission must stay on the selected school.",
      );
    return {
      school: this.origin,
      loginPath: new URL(form.action).pathname,
      method: "POST",
      usernameField: form.username,
      passwordField: form.password,
      csrf: form.fields.has("__RequestVerificationToken"),
    };
  }
  async login(username: string, password: string) {
    const first = await this.request("/");
    const form = loginForm(first.html, first.url);
    if (this.url(form.action).origin !== this.origin)
      throw new IntraError(
        "UNSAFE_REDIRECT",
        "Password submission must stay on the selected school.",
      );
    form.fields.set(form.username, username);
    form.fields.set(form.password, password);
    let page = await this.request(form.action, form.fields);
    page = await this.completeSaml(page);
    if (load(page.html)('input[type="password"]').length)
      throw new IntraError(
        "LOGIN_FAILED",
        "Login was not accepted. Check your credentials.",
      );
    const children = childrenFromHtml(page.html, this.origin);
    if (!children.length)
      throw new IntraError(
        "UNVERIFIED_LOGIN",
        "No child links found; authenticated response needs inspection.",
      );
    return { children, landingUrl: page.url };
  }
  private async completeSaml(page: { html: string; url: string }) {
    // Only the observed SAML assertion consumer can receive the response.
    for (let n = 0; n < 3; n++) {
      const $ = load(page.html);
      const f = $('input[name="SAMLResponse"]').closest("form");
      if (!f.length) break;
      if (f.length !== 1 || f.attr("method")?.toLowerCase() !== "post")
        throw new IntraError(
          "UNSUPPORTED_LOGIN",
          "Unsupported SAML response form.",
        );
      const data = new URLSearchParams();
      f.find('input[type="hidden"][name]').each((_, el) => {
        data.append($(el).attr("name")!, $(el).attr("value") ?? "");
      });
      const action = new URL(f.attr("action") ?? "", page.url);
      if (
        action.origin !== this.origin ||
        action.pathname.toLowerCase() !== "/sso/assertionconsumerservice"
      )
        throw new IntraError("UNSAFE_REDIRECT", "Unverified SAML recipient.");
      page = await this.request(action.href, data);
    }
    return page;
  }
  async children() {
    const page = await this.completeSaml(await this.request("/"));
    if (load(page.html)('input[type="password"]').length)
      throw new IntraError(
        "LOGIN_REQUIRED",
        "Session expired; run login again.",
      );
    const children = childrenFromHtml(page.html, this.origin);
    if (!children.length)
      throw new IntraError(
        "UNRECOGNIZED_PAGE",
        "Cannot identify children; this is not an empty-area result.",
      );
    return children;
  }
}
export { CookieJar };

async function limitedBody(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (!response.body)
    throw new IntraError("EMPTY_RESPONSE", "Response body missing.");
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel();
    throw new IntraError("TOO_LARGE", "Response exceeds size limit.");
  }
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw new IntraError("TOO_LARGE", "Response exceeds size limit.");
      parts.push(value);
    }
    return new Uint8Array(Buffer.concat(parts));
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
}
export { ContentReader } from "./content";
export type { Result, Item, Attachment } from "./content";
