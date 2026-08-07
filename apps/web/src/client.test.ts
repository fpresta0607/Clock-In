import { describe, expect, it, vi } from "vitest";

import { ClientError, createClient } from "./client.js";

const authBaseUrl = "https://auth.test/neondb/auth";
const apiBaseUrl = "https://api.test";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function clientWith(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(handler);
  return { client: createClient({ authBaseUrl, apiBaseUrl, fetch: fetchMock as unknown as typeof fetch }), fetchMock };
}

describe("web client", () => {
  it("signs in, then reaches the API with the token it was given", async () => {
    const { client, fetchMock } = clientWith(async (url) => {
      if (url.endsWith("/sign-in/email")) return jsonResponse({ token: "session" });
      if (url.endsWith("/token")) return jsonResponse({ token: "jwt-1" });
      return jsonResponse({ organization: { id: "o", name: "SIQstack", inviteCode: "ACDEF-GHJKM" } });
    });

    await client.signIn({ email: "alex@example.com", password: "long-enough-password" });
    await client.organization();

    const apiCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/organization"));
    expect((apiCall?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer jwt-1");
  });

  it("sends credentials to the auth host so its session cookie is set and read", async () => {
    const { client, fetchMock } = clientWith(async () => jsonResponse({ token: "jwt-1" }));

    await client.signIn({ email: "alex@example.com", password: "long-enough-password" });

    for (const [url, init] of fetchMock.mock.calls) {
      if (String(url).startsWith(authBaseUrl)) expect(init?.credentials).toBe("include");
    }
  });

  it("never sends the bearer token to the auth host", async () => {
    const { client, fetchMock } = clientWith(async (url) => {
      if (url.endsWith("/token")) return jsonResponse({ token: "jwt-1" });
      return jsonResponse({ token: "session" });
    });

    await client.signIn({ email: "alex@example.com", password: "long-enough-password" });

    for (const [url, init] of fetchMock.mock.calls) {
      if (String(url).startsWith(authBaseUrl)) {
        expect((init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
      }
    }
  });

  it("refreshes an expired token once and retries rather than signing the user out", async () => {
    let tokensIssued = 0;
    let apiCalls = 0;
    const { client } = clientWith(async (url) => {
      if (url.endsWith("/sign-in/email")) return jsonResponse({ token: "session" });
      if (url.endsWith("/token")) {
        tokensIssued += 1;
        return jsonResponse({ token: `jwt-${tokensIssued}` });
      }
      apiCalls += 1;
      // The first API call sees an expired token; the retry succeeds.
      return apiCalls === 1 ? jsonResponse({}, 401) : jsonResponse({ entries: [] });
    });

    await client.signIn({ email: "alex@example.com", password: "long-enough-password" });
    await expect(client.leaderboard()).resolves.toEqual({ entries: [] });
    expect(tokensIssued).toBe(2);
    expect(apiCalls).toBe(2);
  });

  it("gives up as an auth error when the refreshed token is also rejected", async () => {
    const { client } = clientWith(async (url) => {
      if (url.endsWith("/sign-in/email")) return jsonResponse({ token: "session" });
      if (url.endsWith("/token")) return jsonResponse({ token: "jwt" });
      return jsonResponse({}, 401);
    });

    await client.signIn({ email: "alex@example.com", password: "long-enough-password" });

    await expect(client.leaderboard()).rejects.toMatchObject({ kind: "auth" });
  });

  it("names a wrong password without leaking whether the account exists", async () => {
    const { client } = clientWith(async () => jsonResponse({ code: "INVALID_CREDENTIALS" }, 401));

    await expect(client.signIn({ email: "alex@example.com", password: "wrong" })).rejects.toMatchObject({
      kind: "auth",
      message: "Incorrect email or password.",
    });
  });

  it("names the sign-up failures a person can act on", async () => {
    const { client } = clientWith(async () => jsonResponse({ code: "USER_ALREADY_EXISTS" }, 422));

    await expect(client.signUp({ email: "a@b.test", password: "long-enough", name: "Alex" }))
      .rejects.toMatchObject({ kind: "validation", message: expect.stringContaining("Sign in instead") });
  });

  it("provisions with the invite code before anything else creates a workspace", async () => {
    const calls: string[] = [];
    const { client } = clientWith(async (url) => {
      calls.push(new URL(String(url)).pathname);
      if (String(url).endsWith("/token")) return jsonResponse({ token: "jwt" });
      return jsonResponse({ user: { id: "u" } });
    });

    await client.signUp({ email: "a@b.test", password: "long-enough", name: "Alex", inviteCode: "ACDEF-GHJKM" });

    expect(calls).toEqual(["/neondb/auth/sign-up/email", "/neondb/auth/token", "/accounts"]);
  });

  it("reports an unreachable server as transient rather than as a sign-in problem", async () => {
    const { client } = clientWith(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(client.signIn({ email: "a@b.test", password: "x" })).rejects.toMatchObject({ kind: "transient" });
  });

  it("trims trailing slashes so request paths never double up", async () => {
    const { fetchMock } = clientWith(async () => jsonResponse({ token: "jwt" }));
    const client = createClient({
      authBaseUrl: `${authBaseUrl}/`,
      apiBaseUrl: `${apiBaseUrl}/`,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.signIn({ email: "a@b.test", password: "x" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${authBaseUrl}/sign-in/email`);
  });

  it("is a ClientError so callers can branch on kind without parsing messages", async () => {
    const { client } = clientWith(async () => jsonResponse({}, 503));

    await expect(client.signIn({ email: "a@b.test", password: "x" })).rejects.toBeInstanceOf(ClientError);
  });
});
