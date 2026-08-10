/// The account the desktop app is signed in as, and where its time lands.
/// There is no timer state to model any more: recording follows the machine,
/// so the app only ever knows who it is recording for.

export type TimerUser = {
  id: string;
  email: string;
  name: string;
};

export type TimerProject = {
  id: string;
  name: string;
  color: string | null;
};

export type AccountSnapshot =
  | { kind: "signed-out" }
  | {
      kind: "ready";
      user: TimerUser;
      projects: readonly TimerProject[];
      /// Where time lands when nothing else names a project.
      defaultProjectId: string | null;
      /// The project the person pinned recording to, if they pinned one.
      selectedProjectId: string | null;
    };

export type SignedInAccount = Exclude<AccountSnapshot, { kind: "signed-out" }>;
