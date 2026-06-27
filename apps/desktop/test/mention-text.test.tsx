import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MentionText } from "../src/renderer/components/MentionText.js";

describe("MentionText", () => {
  it("renders @/absolute/path mentions as filename chips, keeps surrounding text", () => {
    const { container } = render(<MentionText text="이거 @/abc/def.ts 랑 @/x/y/z.png 보고 해줘" />);
    expect(screen.getByText("@def.ts")).toBeInTheDocument(); // filename only
    expect(screen.getByText("@z.png")).toBeInTheDocument();
    expect(container.textContent).toContain("이거");
    expect(container.textContent).toContain("보고 해줘");
    expect(container.textContent).not.toContain("/abc/def.ts"); // full path is not shown in the body
    expect(screen.getByTitle("/abc/def.ts")).toBeInTheDocument(); // full path goes in the title
  });

  it("plain text without mentions renders unchanged", () => {
    const { container } = render(<MentionText text="그냥 메시지 foo@bar (멘션 아님)" />);
    expect(container.textContent).toBe("그냥 메시지 foo@bar (멘션 아님)");
  });
});
