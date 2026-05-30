// Minimal Node globals for the editor — the repo intentionally has no @types/node.
// tsx strips types at runtime, so this only exists to satisfy the language service.
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
};
