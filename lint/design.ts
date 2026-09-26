import { definePlugin, defineRule } from "vite-plus/lint/plugins";

// Text drawn in the text colour at an opacity of its own: `text-muted` and
// `text-faint` (src/index.css) are the two steps back it may take.
const FADED_TEXT = /\b(?:text|fill)-base-content\/\d+/;

const namedTextColours = defineRule({
  meta: {
    messages: {
      faded:
        "Use `muted` or `faint` (src/index.css) rather than the text colour at an opacity of its own.",
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === "string" && FADED_TEXT.test(node.value)) {
          context.report({ node, messageId: "faded" });
        }
      },
      TemplateElement(node) {
        if (FADED_TEXT.test(node.value.raw)) context.report({ node, messageId: "faded" });
      },
    };
  },
});

export default definePlugin({
  meta: { name: "design" },
  rules: { "named-text-colours": namedTextColours },
});

if (import.meta.vitest) {
  const { describe, it } = import.meta.vitest;
  const { RuleTester } = await import("vite-plus/lint/plugins-dev");
  RuleTester.describe = describe;
  RuleTester.it = it;

  new RuleTester().run("named-text-colours", namedTextColours, {
    valid: [
      `const a = "text-muted text-sm";`,
      `const a = "fill-faint";`,
      // A line or a surface is not text.
      `const a = "stroke-base-content/25 bg-base-content/10";`,
    ],
    // The cases name what the rule reports, so it reports them here too.
    invalid: [
      // oxlint-disable-next-line design/named-text-colours
      { code: `const a = "text-base-content/60 text-sm";`, errors: [{ messageId: "faded" }] },
      // oxlint-disable-next-line design/named-text-colours
      { code: "const a = `fill-base-content/70 ${b}`;", errors: [{ messageId: "faded" }] },
    ],
  });
}
