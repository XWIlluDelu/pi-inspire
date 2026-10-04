/** Pi navigateTree edits user/custom messages before their entry; other nodes
 * continue after it. Selecting the existing leaf is Pi's explicit no-op. */
interface NativeBranchTarget {
  id: string;
  parentId: string | null;
  type: string;
  role?: string;
}

export function isBranchEditTarget(target: NativeBranchTarget): boolean {
  return (
    target.type === "custom_message" ||
    (target.type === "message" && target.role === "user")
  );
}

export function nativeNavigationLeaf(
  target: NativeBranchTarget,
  beforeLeaf: string | null,
): string | null {
  return target.id === beforeLeaf || !isBranchEditTarget(target)
    ? target.id
    : target.parentId;
}
