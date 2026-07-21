import { describe, it, expect } from "vitest";
import { formatMessagePreview } from "./message-preview";

const t = (key: string) => `T:${key}`;

describe("formatMessagePreview", () => {
  it("returns the no-messages-yet label when there is no text", () => {
    const result = formatMessagePreview(null, t);
    expect(result.text).toBe("T:noMessagesYet");
  });

  it("returns the raw text with a generic icon for plain text", () => {
    const result = formatMessagePreview("Oi pai, foi lá no médico?", t);
    expect(result.text).toBe("Oi pai, foi lá no médico?");
  });

  it("returns a translated label for a bracketed audio placeholder", () => {
    const result = formatMessagePreview("[audio]", t);
    expect(result.text).toBe("T:audio");
  });

  it("returns a translated label for a bracketed image placeholder", () => {
    const result = formatMessagePreview("[image]", t);
    expect(result.text).toBe("T:photo");
  });

  it("treats an unrecognized bracket as plain text (falls back to raw)", () => {
    const result = formatMessagePreview("[reaction]", t);
    expect(result.text).toBe("[reaction]");
  });

  it("does not mistake a captioned media message (real text) for a bracket placeholder", () => {
    const result = formatMessagePreview("Confira essa foto!", t);
    expect(result.text).toBe("Confira essa foto!");
  });
});
