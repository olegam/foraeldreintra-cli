import { test, expect } from "bun:test";
import {
  IntraClient,
  childrenFromHtml,
  loginForm,
  schoolOrigin,
} from "./index";
const school = "https://example.m.skoleintra.dk";
const form =
  '<form method="post" action="/Account/IdpLogin"><input type="hidden" name="__RequestVerificationToken" value="csrf-secret"><input name="UserName"><input type="password" name="Password"></form>';
const child =
  '<a href="/parent/12/Anna/news/pins">Anna</a><a href="/parent/42/Bo/news/pins">Bo</a>';
function mock(fn: (url: string, init: RequestInit) => Response): typeof fetch {
  return ((url: any, init: any) =>
    Promise.resolve(fn(String(url), init))) as typeof fetch;
}
test("school validation forbids plaintext, credentials, and deceptive suffix", () => {
  for (const s of [
    "http://example.m.skoleintra.dk",
    school + ".evil.com",
    "https://user:pass@example.m.skoleintra.dk",
  ])
    expect(() => schoolOrigin(s)).toThrow();
});
test("children are discovered without implicitly selecting the first child", () => {
  expect(
    childrenFromHtml(
      child + '<a href="https://evil.com/parent/9/Eve">x</a>',
      school,
    ).map((c) => c.id),
  ).toEqual(["12", "42"]);
});
test("login carries CSRF and scoped cookies and follows POST redirect as GET", async () => {
  let step = 0;
  const client = new IntraClient(
    school,
    undefined,
    mock((url, init) => {
      step++;
      if (step === 1)
        return new Response(form, {
          headers: { "Set-Cookie": "csrf=cookie-secret; Secure; Path=/" },
        });
      if (step === 2) {
        expect(init.method).toBe("POST");
        expect(String(init.body)).toContain(
          "__RequestVerificationToken=csrf-secret",
        );
        expect(String(init.body)).toContain("Password=p%26ss");
        expect((init.headers as any).Cookie).toBe("csrf=cookie-secret");
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/parent/12/Anna",
            "Set-Cookie": "session=secret; Secure; Path=/",
          },
        });
      }
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      return new Response(child);
    }),
  );
  const result = await client.login("user", "p&ss");
  expect(result.children.length).toBe(2);
  expect(JSON.stringify(result)).not.toContain("secret");
});
test("cross-origin form cannot receive credentials", async () => {
  let calls = 0;
  const client = new IntraClient(
    school,
    undefined,
    mock(() => {
      calls++;
      return new Response(
        form.replace("/Account/IdpLogin", "https://evil.com/login"),
      );
    }),
  );
  await expect(client.login("user", "password")).rejects.toMatchObject({
    code: "UNSAFE_REDIRECT",
  });
  expect(calls).toBe(1);
});
test("redirect cannot leak session to another host", async () => {
  let calls = 0;
  const client = new IntraClient(
    school,
    undefined,
    mock(() => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://evil.com/" },
      });
    }),
  );
  await expect(client.children()).rejects.toMatchObject({
    code: "UNSAFE_REDIRECT",
  });
  expect(calls).toBe(1);
});
test("expired login, denied access and unknown page are distinct", async () => {
  for (const [response, code] of [
    [new Response(form), "LOGIN_REQUIRED"],
    [new Response("", { status: 403 }), "ACCESS_DENIED"],
    [new Response("<html>Something changed</html>"), "UNRECOGNIZED_PAGE"],
  ] as const) {
    const client = new IntraClient(
      school,
      undefined,
      mock(() => response),
    );
    await expect(client.children()).rejects.toMatchObject({ code });
  }
});
test("login rejection does not echo page or credentials", async () => {
  const client = new IntraClient(
    school,
    undefined,
    mock(() => new Response(form + "secret-password")),
  );
  await expect(client.login("user", "secret-password")).rejects.toMatchObject({
    code: "LOGIN_FAILED",
    message: "Login was not accepted. Check your credentials.",
  });
});
test("CSRF is required", () => {
  expect(() =>
    loginForm(form.replace("__RequestVerificationToken", "other"), school),
  ).toThrow();
});
test("saved identity-provider session completes only the verified SAML consumer", async () => {
  let step = 0;
  const client = new IntraClient(
    school,
    undefined,
    mock((url, init) => {
      step++;
      if (step === 1)
        return new Response(
          '<form method="post" action="' +
            school +
            '/sso/assertionconsumerservice"><input type="hidden" name="SAMLResponse" value="assertion-secret"></form>',
        );
      expect(init.method).toBe("POST");
      expect(url).toBe(school + "/sso/assertionconsumerservice");
      return new Response(child);
    }),
  );
  expect(await client.children()).toHaveLength(2);
  const malicious = new IntraClient(
    school,
    undefined,
    mock(
      () =>
        new Response(
          '<form method="post" action="/parent/12/Anna/messages/send"><input type="hidden" name="SAMLResponse" value="secret"></form>',
        ),
    ),
  );
  await expect(malicious.children()).rejects.toMatchObject({
    code: "UNSAFE_REDIRECT",
  });
});
