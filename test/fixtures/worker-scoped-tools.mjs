export const inject = ["tools"];
export function apply(ctx) {
  for (const name of ["read", "glob", "grep"]) {
    ctx.tools.register({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      output: {
        schema: { type: "string" },
        render: (_a, value) => [{ type: "text", text: value }],
      },
      async execute() {
        return "preset-only " + name;
      },
    });
  }
}
