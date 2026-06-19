// A companion hook that returns the unit subject's OWN path. The runner's
// subject-read dedupe drops any returned path equal to a unit subject (it is
// already hashed + rendered as the subject), so no companion is injected and no
// extra read: observation is recorded — the verdict hash equals the [] baseline.
export function companion(ctx) {
  const subject = ctx.subject[0];
  if (!subject) throw new Error('self-companion: no subject file for this unit');
  return [{ path: subject.path, label: 'self (deduped)' }];
}
