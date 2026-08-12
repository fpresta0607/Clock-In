import type { LeaderboardResponse, MeResponse, MeStatsResponse, OrganizationResponse, ReportResponse } from "@clock-in/shared";

/**
 * Talks to Neon Auth and the Clock-In API from the browser.
 *
 * Neon Auth keeps its session in a cookie on its own host, so every auth call
 * sends credentials cross-origin. The short-lived JWT it hands back is what the
 * API accepts, and it is held in memory only — never localStorage, where any
 * script on the page could read it.
 */
export type ClientErrorKind = "auth" | "validation" | "transient" | "unknown";

export class ClientError extends Error {
  public constructor(public readonly kind: ClientErrorKind, message: string) {
    super(message);
    this.name = "ClientError";
  }
}

export interface ClientConfig {
  authBaseUrl: string;
  apiBaseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface SignUpInput extends Credentials {
  name: string;
  inviteCode?: string;
  /** Names the workspace this account starts; ignored when an invite code joins one instead. */
  workspaceName?: string;
}

function classify(status: number): ClientError {
  if (status === 401 || status === 403) return new ClientError("auth", "Your session expired. Sign in again.");
  if (status === 404) return new ClientError("validation", "That invite code does not match a workspace.");
  if (status === 409) {
    return new ClientError(
      "validation",
      "This account already recorded time here, so it cannot move. Ask an admin, or use a fresh account.",
    );
  }
  // Nobody composes these requests by hand, so a refused one is never something
  // the reader mistyped: it is this page and the API disagreeing about the
  // request shape. Say that, and name the one thing a reader can actually do.
  if (status === 400 || status === 422) {
    return new ClientError(
      "validation",
      "The server would not accept that request. This page and the server may be running different versions. Reload, and tell an admin if it keeps happening.",
    );
  }
  if (status >= 500) return new ClientError("transient", "The server is unavailable. Try again shortly.");
  return new ClientError("unknown", "That request did not complete.");
}

async function authErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "code" in body) {
      const { code } = body as { code?: unknown };
      return typeof code === "string" ? code : undefined;
    }
  } catch {
    // A body that will not parse tells us nothing; fall back to the status.
  }
  return undefined;
}

export function createClient(config: ClientConfig) {
  const authBaseUrl = config.authBaseUrl.replace(/\/$/, "");
  const apiBaseUrl = config.apiBaseUrl.replace(/\/$/, "");
  const doFetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  let accessToken: string | undefined;

  const authRequest = async (path: string, init: RequestInit = {}): Promise<Response> => {
    try {
      return await doFetch(`${authBaseUrl}${path}`, { ...init, credentials: "include" });
    } catch {
      throw new ClientError("transient", "Cannot reach the sign-in service.");
    }
  };

  /** Trades the Neon Auth session cookie for a JWT the API will accept. */
  const refreshAccessToken = async (): Promise<string> => {
    const response = await authRequest("/token");
    if (!response.ok) throw new ClientError("auth", "Sign in to continue.");
    const body: unknown = await response.json();
    const token = (body as { token?: unknown }).token;
    if (typeof token !== "string" || token.length === 0) {
      throw new ClientError("unknown", "The sign-in service returned no token.");
    }
    accessToken = token;
    return token;
  };

  const apiRequest = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const token = accessToken ?? (await refreshAccessToken());
    const send = (bearer: string) => doFetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${bearer}` },
    });

    let response: Response;
    try {
      response = await send(token);
    } catch {
      throw new ClientError("transient", "Cannot reach the server.");
    }

    // A 15-minute JWT expires during an open dashboard; refresh once and retry
    // rather than bouncing the user back to sign-in.
    if (response.status === 401) {
      const refreshed = await refreshAccessToken();
      try {
        response = await send(refreshed);
      } catch {
        throw new ClientError("transient", "Cannot reach the server.");
      }
    }
    if (!response.ok) throw classify(response.status);
    return response;
  };

  const json = async <T>(path: string): Promise<T> => (await apiRequest(path)).json() as Promise<T>;

  return {
    get hasSession(): boolean {
      return accessToken !== undefined;
    },

    /**
     * Trades a persisted Neon Auth cookie for a fresh JWT on page load, so a
     * returning user skips the sign-in form. False when there is no live cookie.
     */
    async restoreSession(): Promise<boolean> {
      try {
        await refreshAccessToken();
        return true;
      } catch {
        return false;
      }
    },

    async signIn(input: Credentials): Promise<void> {
      const response = await authRequest("/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw response.status === 401 || response.status === 403
          ? new ClientError("auth", "Incorrect email or password.")
          : classify(response.status);
      }
      await refreshAccessToken();
    },

    async signUp(input: SignUpInput): Promise<void> {
      const response = await authRequest("/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: input.email, password: input.password, name: input.name }),
      });
      if (!response.ok) {
        const code = await authErrorCode(response);
        if (code === "USER_ALREADY_EXISTS") {
          throw new ClientError("validation", "That email already has an account. Sign in instead.");
        }
        if (code === "PASSWORD_TOO_SHORT") {
          throw new ClientError("validation", "Choose a password of at least 8 characters.");
        }
        throw classify(response.status);
      }
      await refreshAccessToken();

      // Provision explicitly and first, so the invite code decides the workspace
      // before any other call creates a personal one.
      await apiRequest("/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(input.inviteCode === undefined ? {} : { inviteCode: input.inviteCode }),
          ...(input.workspaceName === undefined ? {} : { workspaceName: input.workspaceName }),
        }),
      });
    },

    async signOut(): Promise<void> {
      accessToken = undefined;
      // Neon Auth refuses any content type but JSON with a 415, and this call is
      // swallowed below, so omitting it signed the tab out while leaving the
      // session cookie alive: the next reload silently signed the person back in.
      await authRequest("/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => undefined);
    },

    organization: () => json<OrganizationResponse>("/organization"),

    /** Moves this account into a teammate's workspace after the fact. */
    async joinOrganization(inviteCode: string): Promise<void> {
      await apiRequest("/organization/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteCode }),
      });
    },

    leaderboard: (query = "") => json<LeaderboardResponse>(`/reports/leaderboard${query}`),
    report: (query = "") => json<ReportResponse>(`/reports${query}`),
    me: () => json<MeResponse>("/me"),
    /** One member's breakdown; `userId` in the query names a teammate. */
    meStats: (query = "") => json<MeStatsResponse>(`/me/stats${query}`),
  };
}

export type Client = ReturnType<typeof createClient>;
