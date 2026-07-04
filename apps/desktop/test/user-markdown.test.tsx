import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UserMarkdown } from "../src/renderer/components/Markdown.js";

// User-message bubble now renders markdown (audit follow-up) while preserving the @file mention chips (rehypeMentions)
// and casual single-newline line breaks (remarkBreaks).
describe("UserMarkdown", () => {
  it("formats markdown in the user bubble", () => {
    const { container } = render(<UserMarkdown content={"**bold** and *em* and `code`"} />);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("em");
    expect(container.querySelector("code")?.textContent).toBe("code");
  });

  it("renders @/absolute/path mentions as filename chips, full path in the title", () => {
    render(<UserMarkdown content={"이거 @/abc/def.ts 랑 @/x/y/z.png 보고 해줘"} />);
    expect(screen.getByText("@def.ts")).toBeInTheDocument(); // filename only, not the full path
    expect(screen.getByText("@z.png")).toBeInTheDocument();
    expect(screen.getByTitle("/abc/def.ts")).toBeInTheDocument(); // full path in the title
  });

  it("does not treat foo@bar as a mention", () => {
    const { container } = render(<UserMarkdown content={"그냥 메시지 foo@bar (멘션 아님)"} />);
    expect(container.textContent).toContain("foo@bar");
    expect(container.querySelector(".md-mention, [class*=inline-flex]")).toBeNull();
  });

  it("keeps a single newline as a line break (remarkBreaks)", () => {
    const { container } = render(<UserMarkdown content={"line 1\nline 2"} />);
    expect(container.querySelector("br")).not.toBeNull();
    expect(container.textContent).toContain("line 1");
    expect(container.textContent).toContain("line 2");
  });
});
