import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { agentRuntimes } from "@clock-in/shared";
import { AgentRuntimeIcon } from "./agent-icons.js";

describe("AgentRuntimeIcon", () => {
  // The roster is the declaration of every runtime Clock-In knows by name, so
  // it is also the list every mark has to cover. A runtime added there without
  // a mark here falls back to a letter tile, which is what the connector list
  // looked like before.
  it.each(agentRuntimes.map((runtime) => [runtime.id, runtime.label] as const))(
    "draws a real mark for %s",
    (id) => {
      render(<AgentRuntimeIcon source={id} />);

      const mark = screen.getByTestId(`agent-mark-${id}`);
      expect(mark.querySelector("svg")).not.toBeNull();
      expect(mark).not.toHaveClass("is-generic");
    },
  );

  it("gives every runtime its own mark rather than one shared glyph", () => {
    const drawn = new Set<string>();
    for (const runtime of agentRuntimes) {
      const { container, unmount } = render(<AgentRuntimeIcon source={runtime.id} />);
      drawn.add(container.innerHTML);
      unmount();
    }
    expect(drawn.size).toBe(agentRuntimes.length);
  });

  // An undeclared runtime is still recorded under its own id, so it still has
  // to render as something. A monogram is honest: Clock-In has no mark for a
  // tool nobody has named yet.
  it("falls back to a monogram for a runtime the roster has never heard of", () => {
    render(<AgentRuntimeIcon source="brand_new_cli" />);

    const mark = screen.getByTestId("agent-mark-brand_new_cli");
    expect(mark).toHaveClass("is-generic");
    expect(mark).toHaveTextContent("B");
  });
});
