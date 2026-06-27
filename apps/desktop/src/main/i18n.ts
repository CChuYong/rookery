// Self-contained i18n for the main process — independent of the renderer catalogs/Vite glob (since it's a separate build target).
type Locale = "ko" | "en";
type Params = Record<string, string | number>;

const ko = {
  "terminal.tooMany": "터미널은 세션당 최대 {max}개까지 열 수 있어요.",
  "terminal.spawnFailed": "셸을 열지 못했어요: {message}",
  "workspace.outsideRoot": "작업 폴더 밖 경로 접근이 거부됐어요: {path}",
  "git.unavailable": "git 사용 불가",
  "git.commandFailed": "git 명령 실패",
  "mkdir.unsupported": "mkdir 미지원",
  "rename.unsupported": "rename 미지원",
  "trash.unsupported": "trash 미지원",
} as const;
const en: Record<keyof typeof ko, string> = {
  "terminal.tooMany": "You can open up to {max} terminals per session.",
  "terminal.spawnFailed": "Couldn't open a shell: {message}",
  "workspace.outsideRoot": "Access to a path outside the work folder was denied: {path}",
  "git.unavailable": "git unavailable",
  "git.commandFailed": "git command failed",
  "mkdir.unsupported": "mkdir not supported",
  "rename.unsupported": "rename not supported",
  "trash.unsupported": "trash not supported",
};
const catalogs: Record<Locale, Record<keyof typeof ko, string>> = { ko, en };
let active: Locale = "en";

export function setMainLocale(loc: string): void {
  active = loc.toLowerCase().startsWith("ko") ? "ko" : "en";
}
export function mt(key: keyof typeof ko, params?: Params): string {
  return catalogs[active][key].replace(/\{(\w+)\}/g, (_m, k: string) => (params && k in params ? String(params[k]) : `{${k}}`));
}
