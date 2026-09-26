import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

/**
 * Asks where to save `contents` and writes it there. The window may write
 * only a path the reader picked in this dialog. Resolves to the file's name,
 * or to null when the reader cancelled.
 */
export async function saveTextFile(
  name: string,
  extension: string,
  contents: string,
): Promise<string | null> {
  const path = await save({
    // A table's name may hold a slash, which would name a folder.
    defaultPath: `${name.replaceAll("/", "-")}.${extension}`,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
  if (path === null) return null;
  await writeTextFile(path, contents);
  return path.split("/").at(-1) ?? path;
}
