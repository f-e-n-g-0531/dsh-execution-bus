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

test("工具声明是简化调用的 Handler 判别联合", () => {
  assert.doesNotThrow(() => assertSupportedJsonSchema(REQUEST_PARAMETERS));
  const oneOf = REQUEST_PARAMETERS.oneOf;
  assert.equal(oneOf.length, Object.keys(EXPECTED).length + 1);
  for (const [handler, required] of Object.entries(EXPECTED)) {
    const variant = oneOf.find((v) => v.properties?.handler?.const === handler);
    assert.ok(variant, "missing variant for " + handler);
    assert.deepEqual(variant.required, ["requestId", "handler", "input"]);
    assert.equal(variant.properties.handler.const, handler);
    assert.deepEqual(variant.properties.input.required, required);
    assert.equal(variant.properties.input.additionalProperties, false);
    assert.equal(variant.properties.requestId.type, "string");
    assert.equal(variant.properties.messageId.type, "string");
  }
  const control = oneOf.at(-1);
  assert.deepEqual(control.required, ["requestId", "type"]);
  assert.deepEqual(control.properties.type.enum, ["status", "result", "cancel"]);
});

test("schema 接受简化请求/控制，拒绝未知 Handler 与混杂字段", () => {
  const req = {
    requestId: "r1",
    handler: "host.read",
    input: { file_path: "README.md" },
  };
  assert.deepEqual(validateJsonSchemaValue(REQUEST_PARAMETERS, req), []);
  assert.deepEqual(
    validateJsonSchemaValue(REQUEST_PARAMETERS, {
      requestId: "r1",
      type: "result",
    }),
    [],
  );
  assert.notDeepEqual(
    validateJsonSchemaValue(REQUEST_PARAMETERS, {
      ...req,
      handler: "host.nope",
    }),
    [],
  );
  assert.notDeepEqual(
    validateJsonSchemaValue(REQUEST_PARAMETERS, { ...req, type: "result" }),
    [],
  );
});

test("PTC SDK 渲染简化调用与 Handler 类型，不再要求构造完整消息", () => {
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
  assert.match(sdk, /requestId: string/);
  assert.match(sdk, /messageId\?: string/);
  assert.match(sdk, /file_path: string/);
  assert.match(sdk, /sandbox_permissions\?: "workspace-write" \| "danger-full-access"/);
  assert.ok(!sdk.includes("protocolVersion"));
  assert.ok(!sdk.includes("payload:"));
});

test("模式提示改为收益导向触发并给出简化调用示例", () => {
  assert.match(MODE_INSTRUCTIONS, /只在能获得协调收益时使用/);
  assert.match(MODE_INSTRUCTIONS, /不是理由/);
  assert.match(MODE_INSTRUCTIONS, /requestId/);
  assert.match(MODE_INSTRUCTIONS, /reused:true/);
  assert.match(MODE_INSTRUCTIONS, /tools\.execution_bus\(/);
  assert.match(MODE_INSTRUCTIONS, /未完成的 request/);
  assert.match(MODE_INSTRUCTIONS, /尽早结束程序/);
  assert.match(REQUEST_DESCRIPTION, /same run_code program/);
  assert.match(REQUEST_DESCRIPTION, /Duration alone is not a reason/);
  assert.match(REQUEST_DESCRIPTION, /reused:true/);
  assert.match(REQUEST_DESCRIPTION, /Diagnostic handler only/);
  assert.ok(!/exceed ~30s/.test(REQUEST_DESCRIPTION));
});
