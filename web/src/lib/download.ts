// Saves an org export as a JSON file through the browser's download, without sending it anywhere.
import type { OrgExport } from "#contract/orgs.ts";

export const saveJson = (fileName: string, value: OrgExport): void => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );

  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // The download has started by the next task; the object URL is no longer needed.
  setTimeout(() => URL.revokeObjectURL(url), 0);
};
