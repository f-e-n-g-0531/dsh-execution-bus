import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSupportedJsonSchema,
  renderToolsSdk,
  validateJsonSchemaValue,
} from "@deepseek-ai/dsh-tools";
import {
  REQUEST_PARAMETERS,
  REQUEST_DESCRIPTION,
  MODE_INSTRUCTIONS,
  PAYLOAD_SCHEMA,
} from "../dist/product.js";

const EXPECTED = {
  "host.read": ["file_path"],
  "host.glob": ["pattern"],
  "host.grep": ["pattern"],
  "host.edit": ["file_path", "old_string", "new_string"],
  "host.write": ["file_path", "content"],
  "host.pwsh": ["description", "command"],
  test: ["delayMs", "fail"],
};

test("执行总线工具声明按 Handler 提供类型化判别联合", () => {
  assert.doesNotThrow(() => assertSupportedJsonSchema(REQUEST_PARAMETERS));
  const oneOf = PAYLOAD_SCHEMA.oneOf;
  assert.equal(oneOf.length, Object.keys(EXPECTED).length + 1);
  for (const [handler, required] of Object.entries(EXPECTED)) {
    const variant = oneOf.find((v) => v.properties?.handler?.const === handler);
    assert.ok(variant, "missing payload variant for " + handler);
    assert.deepEqual(variant.required, ["handler", "input"]);
    assert.equal(variant.properties.handler.const, handler);
    assert.deepEqual(variant.properties.input.required, required);
    assert.equal(variant.properties.input.additionalProperties, false);
  }
  const control = oneOf.at(-1);
  assert.equal(control.type, "object");
  assert.equal(control.additionalProperties, false);
  assert.deepEqual(Object.keys(control.properties), []);
});

test("模型可见 schema 接受合法请求并拒绝未知 Handler", () => {
  const ok = {
    protocolVersion: 1,
    messageId: "m1",
    requestId: "r1",
    type: "request",
    payload: { handler: "host.read", input: { file_path: "README.md" } },
  };
  assert.deepEqual(validateJsonSchemaValue(REQUEST_PARAMETERS, ok), []);
  const control = { ...ok, type: "status", payload: {} };
  assert.deepEqual(validateJsonSchemaValue(REQUEST_PARAMETERS, control), []);
  const unknown = {
    ...ok,
    payload: { handler: "host.nope", input: {} },
  };
  assert.notDeepEqual(validateJsonSchemaValue(REQUEST_PARAMETERS, unknown), []);
});

test("PTC SDK 渲染出 Handler 联合与必填字段，而不是泛型 payload", () => {
  const sdk = renderToolsSdk(
    [
      {
        name: "execution_bus",
        description: REQUEST_DESCRIPTION,
        parameters: REQUEST_PARAMETERS,
        output: {},
      },
    ],
    "function-body",
  );
  for (const handler of Object.keys(EXPECTED))
    assert.ok(sdk.includes('handler: "' + handler + '"'), "missing " + handler);
  assert.match(sdk, /file_path: string/);
  assert.match(sdk, /old_string: string/);
  assert.match(sdk, /sandbox_permissions\?: "workspace-write" \| "danger-full-access"/);
  assert.ok(!sdk.includes("payload: Record<string, JsonValue>"));
});

test("模式提示明确触发条件并给出调用示例", () => {
  for (const text of [REQUEST_DESCRIPTION, MODE_INSTRUCTIONS])
    assert.match(text, /30 ?s|30 秒/);
  assert.match(
    REQUEST_DESCRIPTION,
    /otherwise call the original tool directly|Diagnostic handler only/,
  );
  assert.match(MODE_INSTRUCTIONS, /只在以下情况使用/);
  assert.match(MODE_INSTRUCTIONS, /tools\.execution_bus\(/);
  assert.match(MODE_INSTRUCTIONS, /沿用 requestId/);
});
