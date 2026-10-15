import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ExecutionBus, parse } from "../dist/bus.js";
const owner = { sessionId: "regression", callId: "call" },
  message = {
    protocolVersion: 1,
    messageId: "m",
    requestId: "r",
    type: "request",
    payload: { handler: "h", input: {} },
  };
test("async rejecting observers cannot terminate process or change execution", () => {
  const source =
    "import assert from 'node:assert/strict';import {ExecutionBus} from './dist/bus.js';const b=new ExecutionBus();b.register('h',{validate(){},async run(_,ctx){ctx.progress(1,50);return true}});let count=0;const a=b.submit({sessionId:'s',callId:'c'},{protocolVersion:1,messageId:'m',requestId:'r',type:'request',payload:{handler:'h',input:{}}},async()=>{count++;await Promise.resolve();throw Error('OBSERVER_SECRET')});assert.equal((await a.done).state,'succeeded');await new Promise(r=>setTimeout(r,20));assert.equal(count,3);await b.close();console.log('observer containment passed');";
  const r = spawnSync(
    process.execPath,
    ["--unhandled-rejections=strict", "--input-type=module", "-e", source],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /containment passed/);
  assert.equal(r.stderr, "");
});
test("array subclasses and altered prototypes are rejected without calling serialization hooks", async () => {
  let hooks = 0;
  class List extends Array {
    toJSON() {
      hooks++;
      return ["changed"];
    }
  }
  const custom = ["original"];
  Object.setPrototypeOf(custom, {
    toJSON() {
      hooks++;
      return ["changed"];
    },
  });
  const bare = ["original"];
  Object.setPrototypeOf(bare, null);
  for (const value of [new List("original"), custom, bare]) {
    const b = new ExecutionBus();
    b.register("h", {
      validate() {},
      async run() {
        return value;
      },
    });
    const v = await b.submit(owner, message).done;
    assert.equal(v.state, "unknown");
    assert.equal(v.error, "RESULT_NOT_RETAINED");
    assert.throws(
      () =>
        parse({
          ...message,
          payload: { handler: "h", input: { list: value } },
        }),
      /INVALID_JSON_ARRAY/,
    );
    await b.close();
  }
  assert.equal(hooks, 0);
});
test("plain arrays remain accepted and preserved", async () => {
  const b = new ExecutionBus();
  const value = [null, 1, "文", { list: [true, false] }];
  b.register("h", {
    validate() {},
    async run() {
      return value;
    },
  });
  assert.deepEqual((await b.submit(owner, message).done).result, value);
  await b.close();
});
