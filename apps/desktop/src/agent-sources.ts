import { agentRuntimeLabel } from "@siqshift/shared";

/// Display names for the agent runtimes the hook contract knows about, straight
/// from the shared roster, so one tool is never called two different things and
/// adding a runtime never means editing this file. A runtime the roster has not
/// heard of keeps its own id rather than being relabelled into a neighbour.
export const sourceLabel = (source: string): string => agentRuntimeLabel(source);
