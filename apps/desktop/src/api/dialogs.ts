import { isTauri } from "./index";

export interface FileFilter {
  name: string;
  extensions: string[];
}

/** Native "open file" picker. Returns null when cancelled. In the browser demo it returns a placeholder path. */
export async function pickOpenFile(filters: FileFilter[]): Promise<string | null> {
  if (!isTauri) return `/home/demo/Downloads/demo.${filters[0]?.extensions[0] ?? "json"}`;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: false, directory: false, filters });
  return typeof picked === "string" ? picked : null;
}

/** Native "save file" picker. Returns null when cancelled. */
export async function pickSaveFile(defaultPath: string, filters: FileFilter[]): Promise<string | null> {
  if (!isTauri) return `/home/demo/Downloads/${defaultPath}`;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const picked = await save({ defaultPath, filters });
  return picked ?? null;
}
