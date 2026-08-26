import { describe, expect, it } from "vitest";
import { parseResponsesRequest, RequestError, renderInput } from "../src/responses/request.js";

describe("renderInput", () => {
  it("passes a plain string through", () => {
    expect(renderInput("who won?")).toBe("who won?");
  });

  it("renders a multi-turn transcript", () => {
    const rendered = renderInput([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      { role: "user", content: [{ type: "input_text", text: "and now?" }] },
    ]);
    expect(rendered).toContain("<conversation>");
    expect(rendered).toContain("<assistant>\nhello\n</assistant>");
    expect(rendered).toContain("and now?");
  });

  it("rejects empty input", () => {
    expect(() => renderInput("   ")).toThrow(RequestError);
    expect(() => renderInput(undefined)).toThrow(RequestError);
  });

  it("rejects images", () => {
    expect(() =>
      renderInput([{ role: "user", content: [{ type: "input_image", image_url: "x" }] }]),
    ).toThrow(/not supported/);
  });
});

describe("parseResponsesRequest", () => {
  it("builds a prompt containing the tool manual and instructions", () => {
    const parsed = parseResponsesRequest({
      model: "openai/gpt-5",
      input: "what changed in zig 0.16?",
      instructions: "Be terse.",
    });
    expect(parsed.model).toBe("openai/gpt-5");
    expect(parsed.stream).toBe(false);
    expect(parsed.promptText).toContain("web_search");
    expect(parsed.promptText).toContain("Be terse.");
    expect(parsed.promptText).toContain("what changed in zig 0.16?");
    expect(parsed.prompt).toEqual([{ type: "text", text: parsed.promptText }]);
  });

  it("rejects previous_response_id", () => {
    expect(() => parseResponsesRequest({ input: "hi", previous_response_id: "resp_1" })).toThrow(
      /previous_response_id/,
    );
  });

  it("validates metadata values", () => {
    expect(() => parseResponsesRequest({ input: "hi", metadata: { a: 1 } })).toThrow(RequestError);
  });
});
