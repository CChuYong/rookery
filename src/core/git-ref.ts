// Conservative whitelist for base refs (branch/tag/SHA) controlled by the model/registration.
// Blocks git "option injection" (leading '-' → git parses the value as a flag, e.g. `git diff --output=<path>` → arbitrary file write)
// as well as whitespace/control characters and range (`..`) syntax. A defense-in-depth layer used together with `--end-of-options` at the git call sites.
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function isSafeGitRef(ref: string): boolean {
  if (typeof ref !== "string") return false;
  if (ref.length === 0 || ref.length > 256) return false;
  if (ref.includes("..")) return false; // range/parent syntax — not an ordinary base ref
  return SAFE_REF.test(ref);
}
