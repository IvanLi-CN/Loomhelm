import type { Ledger, Plan } from "../lib/schema";

export function createAtomProjection(ledger: Ledger, plan: Plan) {
  const eventTime = (
    type: string,
    ownerId: string,
    matches: (data: Record<string, unknown>) => boolean,
  ): string | null => {
    const event = [...ledger.events]
      .reverse()
      .find(
        (event) =>
          event.type === type &&
          event.subject_id === ownerId &&
          matches(event.data),
      );
    return event ? (event.occurred_at ?? event.recorded_at) : null;
  };
  const lifecycleTime = (ownerId: string, stage: string): string | null => {
    if (stage === "closed")
      return eventTime(
        "group_updated",
        ownerId,
        (data) => data.state === "closed",
      );
    if (stage === "pr_created")
      return eventTime(
        "publish_pr_resolved",
        ownerId,
        (data) => data.outcome === "succeeded",
      );
    if (stage === "pr_merged")
      return eventTime(
        "merge_resolved",
        ownerId,
        (data) => data.outcome === "succeeded",
      );
    return eventTime(
      "lifecycle_recorded",
      ownerId,
      (data) => data.stage === stage,
    );
  };
  const atomTime = (
    ownerId: string,
    atom: { id: string; status: string; lifecycle_stage?: string | null },
    isGroup = false,
  ): string | null =>
    atom.status === "completed"
      ? (eventTime(
          isGroup ? "group_atom_updated" : "atom_updated",
          ownerId,
          (data) => data.atom_id === atom.id && data.state === "completed",
        ) ??
        (isGroup && atom.lifecycle_stage === "closed"
          ? eventTime(
              "group_updated",
              ownerId,
              (data) => data.state === "closed",
            )
          : null))
      : null;
  return {
    atomTime,
    groups: ledger.groups.map((group) => {
      let plannedAtoms = plan.group_atoms.filter(
        (atom) => atom.group_id === group.id,
      );
      if (!plannedAtoms.length && plan.id === ledger.active_plan_id) {
        const cut = ledger.events.find(
          (event) =>
            event.type === "cut_applied" &&
            event.data.new_group_id === group.id,
        );
        const snapshot = cut?.data.new_group_snapshot as
          Ledger["groups"][number] | undefined;
        if (snapshot)
          plannedAtoms = snapshot.atoms.map(({ status, ...atom }) => ({
            ...atom,
            group_id: group.id,
          }));
      }
      const runtimeAtoms = new Map(group.atoms.map((atom) => [atom.id, atom]));
      const atoms = plannedAtoms.length
        ? plannedAtoms.map((atom) => ({
            id: atom.id,
            title: atom.title,
            purpose: atom.purpose,
            output: atom.output,
            lifecycle_stage: atom.lifecycle_stage,
            status: runtimeAtoms.get(atom.id)?.status ?? "planned",
          }))
        : [];
      const contribution_atoms = ledger.tasks
        .filter((task) => task.group_id === group.id)
        .flatMap((task) => {
          const plannedTaskAtoms = plan.atoms.filter((atom) => atom.task_id === task.id);
          const definitions = plannedTaskAtoms.length
            ? plannedTaskAtoms
            : task.atoms.map((atom) => ({
                id: atom.id,
                title: atom.title,
                purpose: atom.title,
                output: atom.title,
                task_id: task.id,
              }));
          const runtimeAtoms = new Map(task.atoms.map((atom) => [atom.id, atom]));
          return definitions.map((atom) => ({
            id: atom.id,
            title: atom.title,
            purpose: atom.purpose,
            output: atom.output,
            status: runtimeAtoms.get(atom.id)?.status ?? "planned",
            completed_at: atomTime(task.id, runtimeAtoms.get(atom.id) ?? { ...atom, status: "planned" }),
            task_id: task.id,
            task_title: task.title,
          }));
        });
      return {
        ...group,
        atoms: atoms.map((atom) => ({
          ...atom,
          completed_at: atomTime(group.id, atom, true),
        })),
        planned_atoms: plannedAtoms,
        contribution_atoms,
        lifecycle_completed_at: Object.fromEntries(
          Object.entries(group.lifecycle).map(([stage, status]) => [
            stage,
            status === "passed" ? lifecycleTime(group.id, stage) : null,
          ]),
        ),
      };
    }),
  };
}
