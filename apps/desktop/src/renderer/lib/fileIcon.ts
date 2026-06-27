import { addCollection } from "@iconify/react";
import { icons } from "@iconify-json/vscode-icons";

// Register the VSCode Material Icon Theme(=vscode-icons) collection offline — <Icon> renders instantly with no network call.
// Once at module load (addCollection is idempotent). The file tree/finder import this module, so registration happens before render.
addCollection(icons);

const I = (n: string): string => `vscode-icons:${n}`;
export const DEFAULT_FILE_ICON = I("default-file");
export const FOLDER_ICON = I("default-folder");
export const FOLDER_OPEN_ICON = I("default-folder-opened");

// Extension → vscode-icons icon name. (Names are verified against the installed collection's keys.)
const BY_EXT: Record<string, string> = {};
const def = (icon: string, exts: string[]): void => { for (const e of exts) BY_EXT[e] = I(icon); };
def("file-type-typescript", ["ts", "mts", "cts"]);
def("file-type-reactts", ["tsx"]);
def("file-type-js", ["js", "mjs", "cjs"]);
def("file-type-reactjs", ["jsx"]);
def("file-type-json", ["json", "jsonc"]);
def("file-type-python", ["py", "pyi", "pyw"]);
def("file-type-rust", ["rs"]);
def("file-type-go", ["go"]);
def("file-type-java", ["java"]);
def("file-type-kotlin", ["kt", "kts"]);
def("file-type-swift", ["swift"]);
def("file-type-c", ["c"]);
def("file-type-cheader", ["h"]);
def("file-type-cpp", ["cpp", "cc", "cxx"]);
def("file-type-cppheader", ["hpp", "hh"]);
def("file-type-ruby", ["rb"]);
def("file-type-php", ["php"]);
def("file-type-shell", ["sh", "bash", "zsh", "fish"]);
def("file-type-lua", ["lua"]);
def("file-type-sql", ["sql"]);
def("file-type-vue", ["vue"]);
def("file-type-svelte", ["svelte"]);
def("file-type-html", ["html", "htm"]);
def("file-type-css", ["css"]);
def("file-type-scss", ["scss", "sass"]);
def("file-type-less", ["less"]);
def("file-type-markdown", ["md", "mdx", "markdown"]);
def("file-type-text", ["txt", "text", "log", "rst"]);
def("file-type-yaml", ["yaml", "yml"]);
def("file-type-toml", ["toml"]);
def("file-type-ini", ["ini", "cfg", "conf"]);
def("file-type-dotenv", ["env"]);
def("file-type-xml", ["xml"]);
def("file-type-svg", ["svg"]);
def("file-type-image", ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);

// Special cases matched by the full filename rather than an extension (lowercase).
const BY_NAME: Record<string, string> = {
  dockerfile: I("file-type-docker"),
  ".dockerignore": I("file-type-docker"),
  ".gitignore": I("file-type-git"),
  ".gitattributes": I("file-type-git"),
  ".gitmodules": I("file-type-git"),
};

export function fileIcon(name: string): string {
  const base = (name.split("/").pop() ?? name).toLowerCase();
  if (BY_NAME[base]) return BY_NAME[base];
  if (base === ".env" || base.startsWith(".env.")) return I("file-type-dotenv");
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  return BY_EXT[ext] ?? DEFAULT_FILE_ICON;
}
