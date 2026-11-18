import type { Ledger } from "./schema-models";

export function isContinuationPublication(ledger: Ledger, fact: Ledger["facts"][number]): boolean {
  if (fact.continuation === true) return true;
  const operation = ledger.operations.find((item) => item.receipt_fact_id === fact.id);
  return (
    operation?.kind === "publish_pr" &&
    (operation.request as { continuation?: unknown }).continuation === true
  );
}

function requestedPrId(request: Ledger["operations"][number]["request"]): string | null {
  const pr = request.pr;
  return pr && typeof pr === "object" && "id" in pr && typeof pr.id === "string" ? pr.id : null;
}

function publicationPrId(fact: Ledger["facts"][number]): string | null {
  const receipt = fact.receipt;
  if (!receipt || typeof receipt !== "object") return null;
  if ("resource_id" in receipt && typeof receipt.resource_id === "string")
    return receipt.resource_id;
  if ("pr" in receipt && receipt.pr && typeof receipt.pr.id === "string") return receipt.pr.id;
  return null;
}

export function continuationPublicationPending(ledger: Ledger, groupId: string): boolean {
  if (
    ledger.operations.some(
      (item) =>
        item.kind === "publish_pr" &&
        item.target_id === groupId &&
        (item.request as { continuation?: unknown }).continuation === true &&
        (item.status === "claimed" || item.status === "unknown"),
    )
  )
    return true;

  return ledger.facts
    .filter(
      (item) =>
        item.kind === "pr_published" &&
        item.subject_id === groupId &&
        isContinuationPublication(ledger, item),
    )
    .some((publication) => {
      const prId = publicationPrId(publication);
      if (!prId) return true;
      return !ledger.operations.some(
        (item) =>
          item.kind === "merge" &&
          item.target_id === groupId &&
          item.status === "succeeded" &&
          item.request.mode === "parent-followup" &&
          requestedPrId(item.request) === prId,
      );
    });
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
