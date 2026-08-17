import { agentRuntimeLabel, type AgentSource } from "@clock-in/shared";

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
 * 1. The shift's agent has no codebase yet: name it, first assignment wins.
 *    The row keeps its id, so its hours, shifts, tokens and commits graduate
 *    with it and nothing is re-summed.
 * 2. That claim collides, because another shift got to this codebase first:
 *    the shift is re-homed onto the existing agent, and the evidence keyed to
 *    it follows. An unassigned bucket left with no shifts is retired; its
 *    history is empty by construction, so retiring loses nothing.
 * 3. The evidence names a different codebase than the shift's agent already
 *    carries - the agent graduated elsewhere, or was repo-keyed all along:
 *    the shift alone is re-homed onto find-or-create for the named codebase.
 *    This is what keeps an old installer correct for an operator working
 *    several repos: their shared bucket graduates to the first repo reported,
 *    and each later report re-homes only its own shift.
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

  if (current.repoRoot === null && await dependencies.agents.claimRepoRoot(subject.organizationId, current.id, repoRoot, now)) {
    return current.id;
  }

  const target = await mintIdentity();
  if (target === session.agentId) return target;
  await dependencies.agents.restampSession(subject.organizationId, session.id, target, now);
  // Only a bucket can be emptied this way; a repo-keyed agent keeps its row
  // whatever happens to one shift.
  if (current.repoRoot === null) await dependencies.agents.retireIfSessionless(subject.organizationId, current.id, now);
  session.agentId = target;
  return target;
}
