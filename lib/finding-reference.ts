import { findingPaths } from "./company-response-contract";
import { getPath, normalizeReportPath, type Report } from "./report-contract";

type AppliedCorrection = {
  path: string;
  index?: number | null;
  value: unknown;
};
/** Findings refer to the ORIGINAL input revision, just like changes. Resolve
 * identity before looking up a current index: a removed item must never attach
 * its finding to a surviving item which inherited the same numeric index. */
export function resolveFindingReference(
  input: Report,
  current: Report,
  path: string,
  corrections: AppliedCorrection[],
) {
  const inputPath = normalizeReportPath(path);
  if (!findingPaths(input).includes(inputPath))
    throw Error(
      `Finding target '${inputPath}' is not in the generated input-revision catalog.`,
    );
  let currentPath = inputPath;
  for (const arrayPath of new Set(
    corrections.filter((c) => typeof c.index === "number").map((c) => c.path),
  )) {
    if (!inputPath.startsWith(arrayPath + ".")) continue;
    const tail = inputPath.slice(arrayPath.length + 1).split(".");
    if (!/^\d+$/.test(tail[0])) continue;
    const index = Number(tail[0]);
    const removed = corrections.filter(
      (c) =>
        c.path === arrayPath && typeof c.index === "number" && c.value === null,
    );
    if (removed.some((c) => c.index === index))
      return {
        inputPath,
        currentPath: null,
        status: "superseded_by_correction" as const,
      };
    tail[0] = String(index - removed.filter((c) => c.index! < index).length);
    currentPath = arrayPath + "." + tail.join(".");
  }
  if (getPath(current, currentPath) !== undefined)
    return { inputPath, currentPath, status: "active" as const };
  const replacedAncestor = corrections.some((c) => {
    const target =
      typeof c.index === "number"
        ? `${c.path}.${c.index}`
        : c.index === null
          ? null
          : c.path;
    return (
      target && (inputPath === target || inputPath.startsWith(target + "."))
    );
  });
  if (replacedAncestor)
    return {
      inputPath,
      currentPath: null,
      status: "superseded_by_correction" as const,
    };
  throw Error(
    `Generated finding target '${inputPath}' disappeared without an owning correction. No changes were applied.`,
  );
}
