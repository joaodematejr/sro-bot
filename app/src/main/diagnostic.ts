import fs from "node:fs";
import path from "node:path";

import { buildDiagnostic, DIAG_FILES, type DiagnosticParts } from "../controller/diagnostic";

// Le os .json da pasta de dados que entram no diagnostico (nunca os .bin) e monta o texto.
export function collectDiagnostic(dir: string, p: Omit<DiagnosticParts, "files">): string {
  const files: Record<string, string | null> = {};
  for (const name of DIAG_FILES) {
    try {
      files[name] = fs.readFileSync(path.join(dir, name), "utf-8");
    } catch {
      files[name] = null;
    }
  }
  return buildDiagnostic({ ...p, files });
}
