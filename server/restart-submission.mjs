/** Prepare against the captured owner, then distinguish refusal from a lost submission result. */
export async function submitRestart(prepare, issue) {
  try {
    const reason = await prepare();
    if (reason) return { kind: "not-issued", reason };
  } catch (error) {
    return { kind: "not-issued", reason: "pre-restart-failed", error };
  }
  try {
    const issued = await issue();
    if (issued === true) return { kind: "issued" };
    if (issued === false)
      return { kind: "not-issued", reason: "restart-not-issued" };
  } catch {
    // Submission may have reached the owner even if its acknowledgement was lost.
  }
  return { kind: "unconfirmed" };
}

export async function settleRestart(result, release) {
  if (result.kind !== "not-issued") return result;
  try {
    if (await release()) return result;
  } catch {
    // Loss of a release acknowledgement leaves the admission state unknown.
  }
  return { kind: "unconfirmed", reason: "release-unconfirmed" };
}
