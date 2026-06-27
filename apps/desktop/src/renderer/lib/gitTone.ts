// git status letter → Tailwind color token. Shared by GitChanges and FileTree (de-duplicated).
export const GIT_TONE: Record<string, string> = {
  M: "text-run",
  A: "text-pr",
  D: "text-fail",
  "?": "text-muted",
  R: "text-nochg",
  C: "text-nochg",
  U: "text-fail",
};
