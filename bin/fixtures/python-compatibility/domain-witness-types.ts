export type Witness = {
  test_file: string;
  test_name: string;
  label: string;
  keywords?: string[];
};

export type ScenarioWitness = {
  test_file: string;
  test_name: string;
  batch_id: string;
  invariant: string;
  coverage_note: string;
};

export function witness(
  test_file: string,
  test_name: string,
  label: string,
  keywords: string[] = [],
): Witness {
  return { test_file, test_name, label, keywords };
}
