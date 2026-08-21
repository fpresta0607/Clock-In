import { agentRuntimeLabel, type AgentSource } from "@siqshift/shared";

import type { AuthenticatedSubject } from "../auth.js";
import type { AgentRepository, AgentSessionRecord, AgentSessionRepository } from "../repositories.js";
import { rosterEligibleSource } from "./agent-sessions.js";
import { identityRepoRoot } from "./attribution.js";

export interface AgentIdentityDependencies {
  agents: AgentRepository;
  agentSessions: AgentSessionRepository;
}

/**
 * Late discovery of a shift's codebase: graduation, never orphaning.
 *
 * A shift whose desktop could not probe a repository starts in its operator's
 * unassigned bucket. When evidence later names the repo - a commit, or a usage
 * bucket - this brings the shift's identity in line with it:
 *
 * 1. The shift has no identity at all: mint one for the codebase the evidence
 *    names - or the operator's unassigned bucket, when it names only a run -
 *    and stamp the shift with it.
 * 2. The shift is already stamped: find-or-create the identity for the named
 *    codebase and re-home this shift alone onto it, evidence and all. A bucket
 *    left with no shifts is retired; its history is empty by construction, so
 *    retiring loses nothing.
 *
 * A bucket never claims a codebase in place, and only one shift ever moves.
 * The bucket pools every shift whose working directory named no codebase,
 * including each no-mistakes gate run, which reports a per-run worktree -
 * so promoting the row would attribute all that unrelated time to whichever
 * codebase happened to commit first, and the refusal below would leave those
 * run shifts no way back out. The cost is accepted deliberately: an operator
 * whose hook predates the repository probe no longer sees their whole bucket
 * graduate at once. Each shift graduates when its own commit lands, and a
 * shift that never commits stays unassigned, which is honest rather than
 * convenient.
 *
 * Returns the agent the shift belongs to afterwards, or null when the source
 * mints no identity at all.
 */
export async function graduateAgentForSession(
  dependencies: AgentIdentityDependencies,
  subject: AuthenticatedSubject,
  session: AgentSessionRecord,
  source: AgentSource,
  repoRoot: string,
  now: Date,
): Promise<string | null> {
  if (!rosterEligibleSource(source)) return null;

  const mintIdentity = async (): Promise<string> => {
    const minted = await dependencies.agents.upsertForKey({
      organizationId: subject.organizationId,
      ownerUserId: session.userId,
      source,
      repoRoot,
      // A commit names a directory and nothing else, so this lane can only ever
      // reach the path key. That is the honest answer here and a transitional
      // one: once the runtime reports the remote, its own shifts key on the
      // remote directly, and scripts/repair-agent-identity-by-remote.mjs folds
      // whatever this minted into the row the remote identifies.
      repoRemote: null,
      projectId: session.projectId,
      name: agentRuntimeLabel(source),
      now,
    });
    return minted.id;
  };

  // A shift that started before the roster existed, or before its identity
  // could be stamped, mints straight onto the codebase the evidence names -
  // and into its operator's unassigned bucket when the evidence names only a
  // run, because upsertForKey normalizes an opaque root away. This runs before
  // the refusal below on purpose: an unstamped shift must never leave here
  // without an identity, or the caller rejects its commit for a reason the
  // uploader treats as permanent and the evidence is dropped rather than
  // parked until a real codebase names it.
  if (session.agentId === null) {
    const agentId = await mintIdentity();
    await dependencies.agentSessions.stampAgent(subject, session.id, agentId, now);
    session.agentId = agentId;
    return agentId;
  }

  // Evidence that names no codebase re-homes nothing. A commit authored
  // inside a per-run worktree reports that worktree as its repo root, and
  // promoting a stamped agent onto it would strand the shift on an identity
  // named after a run. The shift stays where it is until real evidence arrives.
  if (identityRepoRoot(repoRoot) === null) return session.agentId;

  const current = await dependencies.agents.findById(subject, session.agentId);
  // An agent the caller cannot see is not one to re-home a shift onto.
  if (current === null) return session.agentId;
  if (current.repoRoot === repoRoot) return session.agentId;
  // A remote-keyed identity is never re-homed onto a directory. The commit
  // carries no remote, so the best this lane can mint is the path key for the
  // worktree the commit was authored in - which is precisely the identity the
  // remote was introduced to replace. Demoting would split one repository's
  // shifts back across its worktrees, one commit at a time.
  if (current.repoKey !== null && !current.repoKey.startsWith("path:")) return session.agentId;

  const target = await mintIdentity();
  if (target === session.agentId) return target;
  await dependencies.agents.restampSession(subject.organizationId, session.id, target, now);
  // Only a bucket can be emptied this way; a repo-keyed agent keeps its row
  // whatever happens to one shift.
  if (current.repoKey === null) await dependencies.agents.retireIfSessionless(subject.organizationId, current.id, now);
  session.agentId = target;
  return target;
}
