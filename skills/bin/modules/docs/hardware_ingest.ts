import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return undefined;
    throw error;
  }
}

export interface IngestOptions {
  extractPath: string;
  destDir: string;
  slug: string;
  overwrite?: boolean;
  docSubdir?: string;
  sourceUrl?: string;
  docType?: string;
  vendor?: string;
  part?: string;
  addHeader?: boolean;
  keepMineruJson?: boolean;
  writeLock?: boolean;
  lockGenerated?: boolean;
  createReadme?: boolean;
}

export interface IngestResult {
  pdf: string;
  markdown: string;
  lock?: string;
  notes?: string;
  images?: string;
  metadata?: string;
  lines: string[];
}

function requireSingleOriginPdf(root: string): string {
  const matches = readdirSync(root)
    .filter((name) => name.endsWith("_origin.pdf"))
    .sort();
  if (matches.length === 0)
    throw new Error(`No files matched '*_origin.pdf' under ${root}`);
  if (matches.length > 1)
    throw new Error(
      `Multiple files matched '*_origin.pdf' under ${root}: ${matches.join(", ")}`,
    );
  const path = join(root, matches[0] as string);
  assertSafeSourceEntry(path, "origin PDF");
  return path;
}

function assertSafeSourceEntry(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.nlink > 1)
    throw new Error(`${label} must not be a symlink or hardlink: ${path}`);
  if (!stat.isFile())
    throw new Error(`${label} must be a regular file: ${path}`);
}

function assertSafeSourceTree(root: string): void {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`extract_path must be a real directory: ${root}`);
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const child = lstatSync(path);
    if (child.isSymbolicLink() || (!child.isDirectory() && child.nlink > 1))
      throw new Error(`extract tree contains an unsafe link: ${path}`);
    if (child.isDirectory()) assertSafeSourceTree(path);
    else if (!child.isFile())
      throw new Error(`extract tree entry is not a file: ${path}`);
  }
}

function trustedSystemLinks(): Set<string> {
  return process.platform === "darwin"
    ? new Set(["/etc", "/tmp", "/var"])
    : process.platform === "linux"
      ? new Set(["/bin", "/lib", "/lib64", "/sbin"])
      : new Set<string>();
}

function assertNoUnsafeSymlink(path: string, label: string): void {
  const trustedLinks = trustedSystemLinks();
  let current = resolve(path);
  while (true) {
    if (
      lstatOrUndefined(current)?.isSymbolicLink() &&
      !trustedLinks.has(current)
    )
      throw new Error(`${label} contains a symlink: ${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertSafeDestinationPath(path: string): void {
  assertNoUnsafeSymlink(path, "destination path");
}

function safeRelative(value: string, field: string, nested: boolean): string {
  if (
    !value ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value)
  )
    throw new Error(`${field} must be a relative path`);
  const parts = value.split("/");
  if (!nested && parts.length !== 1)
    throw new Error(`${field} must be a single path component`);
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error(`${field} contains an unsafe path component`);
  return parts.join("/");
}

function replaceExisting(
  path: string,
  overwrite: boolean,
  directory = false,
): void {
  const existing = lstatOrUndefined(path);
  if (!existing) return;
  if (
    existing.isSymbolicLink() ||
    (!existing.isDirectory() && existing.nlink > 1)
  )
    throw new Error(
      `Refusing to operate on an unsafe destination entry: ${path}`,
    );
  if (!overwrite)
    throw new Error(
      `Refusing to overwrite existing ${directory ? "directory" : "file"}: ${path}`,
    );
  rmSync(path, { recursive: directory, force: true });
}

function copyFile(
  source: string,
  destination: string,
  overwrite: boolean,
): void {
  assertSafeDestinationPath(destination);
  replaceExisting(destination, overwrite);
  mkdirSync(resolve(destination, ".."), { recursive: true });
  cpSync(source, destination, { preserveTimestamps: true });
}

function copyTree(
  source: string,
  destination: string,
  overwrite: boolean,
): void {
  assertSafeDestinationPath(destination);
  replaceExisting(destination, overwrite, true);
  mkdirSync(resolve(destination, ".."), { recursive: true });
  cpSync(source, destination, { recursive: true, preserveTimestamps: true });
}

export function rewriteImagePaths(markdown: string, slug: string): string {
  const prefix = `${slug}.assets/images/`;
  return markdown
    .replaceAll("(./images/", `(${prefix}`)
    .replaceAll("(images/", `(${prefix}`)
    .replaceAll('src="./images/', `src="${prefix}`)
    .replaceAll("src='./images/", `src='${prefix}`)
    .replaceAll('src="images/', `src="${prefix}`)
    .replaceAll("src='images/", `src='${prefix}`);
}

export function buildHeader(options: IngestOptions): string {
  const lines: string[] = [];
  for (const [label, value] of [
    ["Type", options.docType],
    ["Vendor", options.vendor],
    ["Part", options.part],
    ["Source", options.sourceUrl],
  ] as const) {
    if (value) lines.push(`> ${label}: ${value}`);
  }
  lines.push(`> PDF: \`${options.slug}.pdf\``);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n\n`;
}

export function buildNotesReadme(options: IngestOptions): string {
  const title =
    [options.vendor, options.part, options.docType].filter(Boolean).join(" ") ||
    options.slug;
  const lines = [
    `# ${title}`,
    "",
    "This folder contains a **generated** Markdown mirror of the vendor document:",
    "",
    `- Generated Markdown (**DO NOT EDIT**): \`${options.slug}.md\``,
    `- Source PDF (fidelity): \`${options.slug}.pdf\``,
  ];
  if (options.sourceUrl) lines.push(`- Source URL: ${options.sourceUrl}`);
  lines.push(
    "",
    "## Notes (editable)",
    "",
    "- Summary:",
    "- Key specs:",
    "- Project decisions / remarks:",
    "",
  );
  return lines.join("\n");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function buildLock(
  options: IngestOptions,
  markdown: string,
  pdf: string,
): string {
  return `${JSON.stringify(
    {
      artifacts: {
        md: { path: `${options.slug}.md`, sha256: sha256(markdown) },
        pdf: { path: `${options.slug}.pdf`, sha256: sha256(pdf) },
      },
      generated_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
      generator: { tool: "ingest_mineru_extract.ts" },
      schema: "codex.hardware-doc-ingest.lock.v1",
      slug: options.slug,
      source: {
        doc_type: options.docType ?? null,
        part: options.part ?? null,
        url: options.sourceUrl ?? null,
        vendor: options.vendor ?? null,
      },
    },
    null,
    2,
  )}\n`;
}

export function ingestExtract(input: IngestOptions): IngestResult {
  const options = {
    overwrite: false,
    addHeader: false,
    keepMineruJson: false,
    writeLock: true,
    lockGenerated: true,
    createReadme: true,
    ...input,
  };
  const extract = resolve(options.extractPath);
  const destination = resolve(options.destDir);
  if (!existsSync(extract) || !statSync(extract).isDirectory())
    throw new Error(
      `extract_path does not exist or is not a directory: ${extract}`,
    );
  assertNoUnsafeSymlink(extract, "extract path");
  assertSafeSourceTree(extract);
  assertSafeDestinationPath(destination);
  const slug = safeRelative(options.slug, "slug", false);
  const docSubdir = options.docSubdir
    ? safeRelative(options.docSubdir, "doc-subdir", true)
    : undefined;
  options.slug = slug;
  if (docSubdir === undefined) delete options.docSubdir;
  else options.docSubdir = docSubdir;
  const fullMarkdown = join(extract, "full.md");
  if (!existsSync(fullMarkdown))
    throw new Error(`Missing full.md under ${extract}`);
  assertSafeSourceEntry(fullMarkdown, "full.md");
  const originPdf = requireSingleOriginPdf(extract);
  const root = docSubdir ? join(destination, docSubdir) : destination;
  const markdown = join(root, `${slug}.md`);
  const pdf = join(root, `${slug}.pdf`);
  const assets = join(root, `${slug}.assets`);
  const notes = join(root, docSubdir ? "README.md" : `${slug}.README.md`);
  const lock = join(root, `${slug}.lock.json`);
  assertSafeDestinationPath(root);

  copyFile(originPdf, pdf, options.overwrite);
  let content = rewriteImagePaths(readFileSync(fullMarkdown, "utf8"), slug);
  if (options.addHeader) content = buildHeader(options) + content;
  replaceExisting(markdown, options.overwrite);
  mkdirSync(resolve(markdown, ".."), { recursive: true });
  writeFileSync(markdown, content, "utf8");
  const images = join(extract, "images");
  const destinationImages = join(assets, "images");
  if (existsSync(images) && statSync(images).isDirectory())
    copyTree(images, destinationImages, options.overwrite);
  let metadata: string | undefined;
  if (options.keepMineruJson) {
    metadata = join(assets, "mineru");
    assertSafeDestinationPath(metadata);
    mkdirSync(metadata, { recursive: true });
    for (const entry of readdirSync(extract)) {
      if (entry.endsWith(".json")) {
        assertSafeSourceEntry(join(extract, entry), `metadata ${entry}`);
        copyFile(
          join(extract, entry),
          join(metadata, entry),
          options.overwrite,
        );
      }
    }
  }
  let notesPath: string | undefined;
  if (options.createReadme) {
    const existingNotes = lstatOrUndefined(notes);
    if (
      existingNotes?.isSymbolicLink() ||
      (existingNotes && existingNotes.nlink > 1)
    )
      throw new Error(
        `Refusing to operate on an unsafe destination entry: ${notes}`,
      );
    if (!existingNotes) {
      assertSafeDestinationPath(notes);
      mkdirSync(resolve(notes, ".."), { recursive: true });
      writeFileSync(notes, buildNotesReadme(options), "utf8");
    }
    if (lstatOrUndefined(notes)) notesPath = notes;
  }
  let lockPath: string | undefined;
  if (options.writeLock) {
    lockPath = lock;
    replaceExisting(lock, options.overwrite);
    writeFileSync(lock, buildLock(options, markdown, pdf), "utf8");
  }
  if (options.lockGenerated) {
    try {
      chmodSync(markdown, 0o444);
      chmodSync(pdf, 0o444);
    } catch {
      /* best effort */
    }
  }
  const lines = [
    `Staged mineru extract:`,
    `- PDF: ${pdf}`,
    `- MD:  ${markdown}`,
  ];
  if (lockPath) lines.push(`- LOCK: ${lockPath}`);
  if (notesPath) lines.push(`- NOTES: ${notesPath}`);
  if (existsSync(destinationImages)) lines.push(`- IMG: ${destinationImages}`);
  if (metadata) lines.push(`- META: ${metadata}`);
  return {
    pdf,
    markdown,
    ...(lockPath ? { lock: lockPath } : {}),
    ...(notesPath ? { notes: notesPath } : {}),
    ...(existsSync(destinationImages) ? { images: destinationImages } : {}),
    ...(metadata ? { metadata } : {}),
    lines,
  };
}
