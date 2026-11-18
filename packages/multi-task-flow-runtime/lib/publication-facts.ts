import type { Ledger } from "./schema-models";

export function isContinuationPublication(ledger: Ledger, fact: Ledger["facts"][number]): boolean {
  const operation = ledger.operations.find((item) => item.receipt_fact_id === fact.id);
  return (
    operation?.kind === "publish_pr" &&
    (operation.request as { continuation?: unknown }).continuation === true
  );
}

export function latestPublicationFact(
  ledger: Ledger,
  targetId: string,
  kind: "branch_published" | "pr_published",
  includeContinuation = true,
): Ledger["facts"][number] | null {
  return (
    ledger.facts
      .filter(
        (item) =>
          item.kind === kind &&
          item.subject_id === targetId &&
          (includeContinuation || !isContinuationPublication(ledger, item)),
      )
      .sort((left, right) => left.observed_at.localeCompare(right.observed_at))
      .at(-1) ?? null
  );
}
