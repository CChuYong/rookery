// A worker branch is `rookery/<uuid>`: show the first uuid block (like a short commit hash); callers keep the full
// name in a title. Anything that is not a rookery uuid branch passes through unchanged.
export const shortBranch = (b: string): string => b.replace(/^(rookery\/[0-9a-f]{8})-[0-9a-f-]+$/i, "$1");
