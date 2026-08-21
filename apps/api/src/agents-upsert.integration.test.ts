import { randomUUID } from "node:crypto";

import {
  createDisposableTestDatabase,
  runMigrations,
  type DatabaseConnection,
  type DisposableTestDatabase,
} from "@siqshift/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "./auth.js";
import { DrizzleAgentRepository } from "./drizzle-repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL || undefined;
const integration = databaseUrl ? describe : describe.skip;

// The roster identity key is (organization, operator, source, repo_root) with
// repo_root nullable. Two things about it are invisible to a mocked
// repository and only fail where a real planner has to pick an index:
//
//   - a plain unique treats nulls as distinct, so the unassigned half is its
//     own partial index on (organization, operator, source) where repo_root is
//     null - that is what makes two repo-less sightings one agent per operator;
//   - postgres matches ON CONFLICT to a partial index by its predicate, so an
//     arbiter whose targetWhere does not restate the index's own predicate
//     passes every mock and then fails every insert in production.
//
// So this runs the real upsert against a real PostgreSQL server.
integration("agents operator-and-repo identity upsert", () => {
  let disposable: DisposableTestDatabase | undefined;
  let database = undefined as unknown as DatabaseConnection;
  const organizationId = randomUUID();
  const ownerUserId = randomUUID();
  const otherUserId = randomUUID();
  const projectId = randomUUID();
  const subject: AuthenticatedSubject = { organizationId, userId: ownerUserId, role: "member" };
  const siqshift = "C:/dev/siqshift";
  const piggies = "C:/dev/pocket-piggies";
  let repository: DrizzleAgentRepository;

  beforeAll(async () => {
    if (!databaseUrl) return;
    disposable = await createDisposableTestDatabase(databaseUrl, "agents_upsert");
    database = disposable.database;
    await runMigrations(database);
    await database.client`
      insert into organizations (id, name, invite_code)
      values (${organizationId}, 'Roster Test', ${randomUUID().slice(0, 11)})
    `;
    await database.client`
      insert into users (id, organization_id, email, name, role)
      values (${ownerUserId}, ${organizationId}, 'roster@siqshift.test', 'Roster User', 'member'),
             (${otherUserId}, ${organizationId}, 'other@siqshift.test', 'Other User', 'member')
    `;
    await database.client`
      insert into projects (id, organization_id, name)
      values (${projectId}, ${organizationId}, 'Field work')
    `;
    repository = new DrizzleAgentRepository(database.db);
  }, 60_000);

  afterAll(async () => {
    if (disposable === undefined) return;
    await disposable.cleanup();
  });

  it("answers a replayed repo-less key with the same identity", async () => {
    const now = new Date();
    const key = { organizationId, ownerUserId, source: "claude_code", repoRoot: null, repoRemote: null, projectId: null, name: "Claude Code", now } as const;
    const first = await repository.upsertForKey(key);
    const replay = await repository.upsertForKey(key);

    expect(replay.id).toBe(first.id);
    const record = await repository.findById(subject, first.id);
    expect(record?.name).toBe("Claude Code @ unassigned");
    expect(record?.repoRoot).toBeNull();
    expect(record?.status).toBe("anonymous");
  });

  // The roster filled with a row per gate run: tooling that checks a repo out
  // per run leaves a working directory named after the run, and identity keys
  // on that directory. A run names no codebase, so it identifies none.
  it("collapses two per-run worktrees onto the one unassigned identity", async () => {
    const now = new Date();
    const base = { organizationId, ownerUserId, source: "amp", repoRemote: null, projectId: null, name: "Amp", now } as const;
    const worktrees = "C:/Users/alex/.no-mistakes/repos/3245fe18a7c8.git/worktrees";
    const firstRun = await repository.upsertForKey({ ...base, repoRoot: `${worktrees}/01M06FSGP392MH6VJNRX8T364A` });
    const secondRun = await repository.upsertForKey({ ...base, repoRoot: `${worktrees}/01M08C82C40W5Y5Q0X3BFGYNFT` });

    expect(secondRun.id).toBe(firstRun.id);
    const record = await repository.findById(subject, firstRun.id);
    // Keyed on nothing and named after nothing: the row a run reaches is the
    // operator's bucket, which is also where a repo-less sighting lands.
    expect(record?.repoRoot).toBeNull();
    expect(record?.name).toBe("Amp @ unassigned");
    await expect(repository.upsertForKey({ ...base, repoRoot: null })).resolves.toEqual({ id: firstRun.id });
  });

  it("mints a separate identity per repo and names it from the repo's folder", async () => {
    const now = new Date();
    const base = { organizationId, ownerUserId, source: "claude_code", repoRemote: null, projectId, name: "Claude Code", now } as const;
    const unassigned = await repository.upsertForKey({ ...base, repoRoot: null, repoRemote: null, projectId: null });
    const scoped = await repository.upsertForKey({ ...base, repoRoot: siqshift });
    const sibling = await repository.upsertForKey({ ...base, repoRoot: piggies });

    // Two repos inside one project are two agents; before v2 they collapsed.
    expect(new Set([unassigned.id, scoped.id, sibling.id]).size).toBe(3);
    const record = await repository.findById(subject, scoped.id);
    expect(record?.name).toBe("Claude Code @ siqshift");
    expect(record?.repoRoot).toBe(siqshift);
    // The project rides along as a re-derivable attribute, not as identity.
    expect(record?.project).toEqual({ id: projectId, name: "Field work" });
  });

  it("gives each operator their own identity for the same runtime and repo", async () => {
    const now = new Date();
    const base = { organizationId, source: "codex", repoRoot: siqshift, repoRemote: null, projectId: null, name: "Codex", now } as const;
    const mine = await repository.upsertForKey({ ...base, ownerUserId });
    const theirs = await repository.upsertForKey({ ...base, ownerUserId: otherUserId });

    // This is the whole point of v2: whoever minted first no longer owns
    // every other member's shifts.
    expect(theirs.id).not.toBe(mine.id);
    expect((await repository.findById(subject, theirs.id))?.owner.id).toBe(otherUserId);
  });

  it("gives each operator their own unassigned bucket", async () => {
    const now = new Date();
    const base = { organizationId, source: "kimi_code", repoRoot: null, repoRemote: null, projectId: null, name: "Kimi Code", now } as const;
    const mine = await repository.upsertForKey({ ...base, ownerUserId });
    const theirs = await repository.upsertForKey({ ...base, ownerUserId: otherUserId });

    expect(theirs.id).not.toBe(mine.id);
    await expect(repository.upsertForKey({ ...base, ownerUserId })).resolves.toEqual({ id: mine.id });
  });

  // Retiring has to mean retired. While the identity key covered every row,
  // the next shift conflicted onto the retired agent and put it straight back
  // on the pay run - which also undid every merge on the following shift.
  it("mints a fresh identity once a retired one has released the key", async () => {
    const now = new Date();
    const key = { organizationId, ownerUserId, source: "cursor", repoRoot: siqshift, repoRemote: null, projectId, name: "Cursor", now } as const;
    const first = await repository.upsertForKey(key);
    await database.client`update agents set status = 'retired' where id = ${first.id}`;

    const replacement = await repository.upsertForKey(key);

    expect(replacement.id).not.toBe(first.id);
    expect((await repository.findById(subject, first.id))?.status).toBe("retired");
    expect((await repository.findById(subject, replacement.id))?.status).toBe("anonymous");
  });

  it("mints a fresh unassigned identity once the retired one has released the key", async () => {
    const now = new Date();
    const key = { organizationId, ownerUserId, source: "opencode", repoRoot: null, repoRemote: null, projectId: null, name: "opencode", now } as const;
    const first = await repository.upsertForKey(key);
    await database.client`update agents set status = 'retired' where id = ${first.id}`;

    const replacement = await repository.upsertForKey(key);

    expect(replacement.id).not.toBe(first.id);
    // And the replacement is still one identity, not one row per sighting.
    await expect(repository.upsertForKey(key)).resolves.toEqual({ id: replacement.id });
  });

  // Releasing the key means something else can take it, so bringing the
  // retired row back is a conflict the caller can act on rather than a 500.
  it("refuses to un-retire an identity another agent now holds", async () => {
    const now = new Date();
    const key = { organizationId, ownerUserId, source: "copilot", repoRoot: siqshift, repoRemote: null, projectId, name: "Copilot", now } as const;
    const retired = await repository.upsertForKey(key);
    await database.client`update agents set status = 'retired' where id = ${retired.id}`;
    await repository.upsertForKey(key);

    await expect(repository.update(subject, retired.id, { status: "registered", updatedAt: now }))
      .rejects.toMatchObject({ code: "conflict" });
    expect((await repository.findById(subject, retired.id))?.status).toBe("retired");
  });

  // A bucket never graduates in place, so the codebase a shift's commit names
  // is reached the same way every other identity is: find-or-create. The
  // bucket keeps its own row for the shifts still pooled in it.
  it("answers a graduating shift with the codebase's own identity, never the bucket's", async () => {
    const now = new Date();
    const base = { organizationId, ownerUserId, source: "grok", repoRemote: null, projectId: null, name: "Grok", now } as const;
    const bucket = await repository.upsertForKey({ ...base, repoRoot: null });

    const graduated = await repository.upsertForKey({ ...base, repoRoot: piggies });

    expect(graduated.id).not.toBe(bucket.id);
    expect((await repository.findById(subject, bucket.id))?.repoRoot).toBeNull();
    expect((await repository.findById(subject, graduated.id))?.repoRoot).toBe(piggies);
    // A second shift naming the same codebase reaches that identity, not a
    // duplicate of it.
    await expect(repository.upsertForKey({ ...base, repoRoot: piggies })).resolves.toEqual({ id: graduated.id });
  });

  it("retires an emptied unassigned bucket, and leaves one that still has shifts", async () => {
    const now = new Date();
    const key = { organizationId, ownerUserId, source: "pi", repoRoot: null, repoRemote: null, projectId: null, name: "Pi", now } as const;
    const bucket = await repository.upsertForKey(key);

    await expect(repository.retireIfSessionless(organizationId, bucket.id, now)).resolves.toBe(true);
    expect((await repository.findById(subject, bucket.id))?.status).toBe("retired");

    const kept = await repository.upsertForKey(key);
    await database.client`
      insert into agent_sessions (organization_id, user_id, source, external_session_id, agent_id, status, started_at, ended_at, last_event_at, received_at)
      values (${organizationId}, ${ownerUserId}, 'pi', ${randomUUID()}, ${kept.id}, 'ended', now(), now(), now(), now())
    `;
    await expect(repository.retireIfSessionless(organizationId, kept.id, now)).resolves.toBe(false);
    expect((await repository.findById(subject, kept.id))?.status).toBe("anonymous");
  });

  // Naming an agent registers it, so 'anonymous' is what marks a row as still
  // machine-minted. An emptied bucket someone named keeps its id and its name.
  it("leaves an emptied unassigned bucket alone once a member has named it", async () => {
    const now = new Date();
    const key = { organizationId, ownerUserId, source: "zed", repoRoot: null, repoRemote: null, projectId: null, name: "Zed", now } as const;
    const named = await repository.upsertForKey(key);
    await repository.update(subject, named.id, { name: "Alex's helper", status: "registered", updatedAt: now });

    await expect(repository.retireIfSessionless(organizationId, named.id, now)).resolves.toBe(false);
    expect(await repository.findById(subject, named.id)).toMatchObject({ name: "Alex's helper", status: "registered" });
  });
  // The regression this whole change exists for, and the one the Overlord has
  // now reported twice. Five `precisiondocs` rows sat on one roster because
  // every treehouse worktree is its own path and identity keyed on the path,
  // while the name was composed from the last segment - so all five rendered
  // the same string. Keyed by path, displayed by basename.
  //
  // It runs against a real PostgreSQL because the collapse is enforced by the
  // partial unique index, and an ON CONFLICT arbiter whose predicate does not
  // restate that index's own predicate passes every mock and then fails every
  // insert.
  it("gives two worktrees of one remote a single identity", async () => {
    const now = new Date();
    const remote = "git@github.com:fpresta0607/precisiondocs.git";
    const base = { organizationId, ownerUserId, source: "claude_code", projectId: null, name: "Claude Code", now } as const;
    const worktrees = [
      "C:/Users/fpres/.treehouse/precisiondocs-fdd5f2/1/precisiondocs",
      "C:/Users/fpres/.treehouse/precisiondocs-fdd5f2/2/precisiondocs",
      "C:/Users/fpres/.treehouse/precisiondocs-fdd5f2/3/precisiondocs",
    ];
    const minted = [];
    for (const repoRoot of worktrees) {
      minted.push(await repository.upsertForKey({ ...base, repoRoot, repoRemote: remote }));
    }

    expect(new Set(minted.map((agent) => agent.id)).size).toBe(1);
    const record = await repository.findById(subject, minted[0]!.id);
    expect(record?.repoKey).toBe("github.com/fpresta0607/precisiondocs");
    // The root stays on the row as evidence of where the work happened - the
    // first worktree that minted it - and never moves the identity again.
    expect(record?.repoRoot).toBe(worktrees[0]);
    expect(record?.name).toBe("Claude Code @ precisiondocs");
  });

  // `PrecisionDocs-AI` and `precisiondocs` are one GitHub repository checked
  // out twice on one machine, under two directory names and two different
  // spellings of the same remote. No basename comparison could ever collapse
  // these; only the remote can.
  it("gives two checkouts of one repository a single identity, whatever they are called", async () => {
    const now = new Date();
    const base = { organizationId, ownerUserId, source: "codex", projectId: null, name: "Codex", now } as const;
    const first = await repository.upsertForKey({
      ...base,
      repoRoot: "C:/dev/PrecisionDocs-AI",
      repoRemote: "https://github.com/fpresta0607/PrecisionDocs-AI.git",
    });
    const second = await repository.upsertForKey({
      ...base,
      repoRoot: "C:/dev/code-goblins/projects/precisiondocs",
      repoRemote: "git@github.com:fpresta0607/precisiondocs-ai.git",
    });

    expect(second.id).toBe(first.id);
    // One name for the repository, taken from the remote, rather than from
    // whichever checkout's directory happened to mint the row. Reading the
    // directory first is how a worktree's folder name became the displayed
    // codebase for a whole repository.
    expect((await repository.findById(subject, first.id))?.name).toBe("Codex @ precisiondocs-ai");
  });

  // The label follows the identity even when the directory could have supplied
  // one: a worktree checked out under a branch name is still that repository,
  // and every shift from every worktree has to read as the same codebase.
  it("names a worktree's row after its repository, not after the worktree's folder", async () => {
    const now = new Date();
    const base = { organizationId, ownerUserId, source: "opencode", projectId: null, name: "opencode", now } as const;
    const worktree = await repository.upsertForKey({
      ...base,
      repoRoot: "C:/dev/clock-in-worktrees/fix-login",
      repoRemote: "git@github.com:acme/clock-in.git",
    });

    const record = await repository.findById(subject, worktree.id);
    expect(record?.name).toBe("opencode @ clock-in");
    expect(record?.repoRoot).toBe("C:/dev/clock-in-worktrees/fix-login");
  });

  // A worktree named after its run identifies no codebase by itself, which is
  // why it used to land in the bucket. Its remote identifies the repository
  // all the same, so the shift reaches that repository's row - and reads as
  // that codebase rather than as "unassigned".
  it("keys a run-named worktree on its remote, and says which codebase it is", async () => {
    const now = new Date();
    const base = { organizationId, ownerUserId, source: "amp", projectId: null, name: "Amp", now } as const;
    const slug = await repository.upsertForKey({
      ...base,
      repoRoot: "C:/Users/fpres/.treehouse/goofy-haslett-4b3191",
      repoRemote: "git@github.com:acme/instantly-client.git",
    });
    const checkout = await repository.upsertForKey({
      ...base,
      repoRoot: "C:/dev/instantly-client",
      repoRemote: "https://github.com/acme/instantly-client",
    });

    expect(checkout.id).toBe(slug.id);
    const record = await repository.findById(subject, slug.id);
    expect(record?.name).toBe("Amp @ instantly-client");
    expect(record?.repoKey).toBe("github.com/acme/instantly-client");
  });

  // A repository with no remote is legitimate, and collapsing every one of
  // them into a single bucket would be a different bug of the same family.
  it("keeps two local-only repositories apart, and out of the bucket", async () => {
    const now = new Date();
    const base = { organizationId, ownerUserId, source: "cursor", repoRemote: null, projectId: null, name: "Cursor", now } as const;
    const scratch = await repository.upsertForKey({ ...base, repoRoot: "C:/dev/scratchpad" });
    const notes = await repository.upsertForKey({ ...base, repoRoot: "C:/dev/notes" });
    const bucket = await repository.upsertForKey({ ...base, repoRoot: null });

    expect(new Set([scratch.id, notes.id, bucket.id]).size).toBe(3);
    expect((await repository.findById(subject, scratch.id))?.repoKey).toBe("path:C:/dev/scratchpad");
    expect((await repository.findById(subject, bucket.id))?.repoKey).toBeNull();
    // Replay finds the same row rather than minting a second one - which is
    // also what makes 0016's `'path:' || repo_root` backfill land on the key
    // this lane composes.
    await expect(repository.upsertForKey({ ...base, repoRoot: "C:/dev/scratchpad" })).resolves.toEqual({ id: scratch.id });
  });

  // The transition, in one test: a desktop that predates the remote probe
  // keyed on the path, then the same repository arrives with its remote. The
  // two are separate rows on purpose - nothing in the API can know they are
  // the same repository, because only a machine holding the checkout can read
  // the remote - and scripts/repair-agent-identity-by-remote.mjs is what folds
  // them together. What must not happen is the reverse: a later path-keyed
  // sighting must never split the remote-keyed row again.
  it("keeps a remote-keyed identity stable once it exists", async () => {
    const now = new Date();
    const base = { organizationId, ownerUserId, source: "kimi_code", projectId: null, name: "Kimi Code", now } as const;
    const root = "C:/dev/legacy-checkout";
    const beforeProbe = await repository.upsertForKey({ ...base, repoRoot: root, repoRemote: null });
    const afterProbe = await repository.upsertForKey({ ...base, repoRoot: root, repoRemote: "git@github.com:acme/legacy.git" });

    expect(afterProbe.id).not.toBe(beforeProbe.id);
    const replay = await repository.upsertForKey({ ...base, repoRoot: "C:/other/legacy", repoRemote: "https://github.com/acme/legacy.git" });
    expect(replay.id).toBe(afterProbe.id);
  });
});
