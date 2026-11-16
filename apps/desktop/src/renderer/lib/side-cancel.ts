// The Side drawer was closed while its conversation was still opening (final review #8). The opening rejects with
// this so the source draft is kept, but it is the user's own cancel: callers show nothing for it.
export class SideOpenCancelled extends Error {
  constructor() {
    super("Side opening cancelled");
    this.name = "SideOpenCancelled";
  }
}

export function isSideOpenCancelled(err: unknown): err is SideOpenCancelled {
  return err instanceof SideOpenCancelled;
}
