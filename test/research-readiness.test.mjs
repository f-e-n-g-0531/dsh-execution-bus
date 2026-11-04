import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("research plan separates public baseline, pending acceptance and conditional optimization", () => {
  const plan = readFileSync("docs/DEVELOPMENT-PLAN.md", "utf8");
  const validation = readFileSync("docs/validation.md", "utf8");
  for (const text of [plan, validation]) {
    assert.match(text, /v1\.3\.2/);
    assert.match(text, /8d1a5bf/);
    assert.match(text, /v1\.3\.0 是历史研发起点/);
    assert.match(text, /RESEARCH-READINESS\.md/);
    assert.match(text, /pending/);
  }
  assert.match(plan, /当前不接 top-k/);
  assert.match(plan, /停止性能实现/);
  assert.match(plan, /独立未插桩对照/);
  assert.match(plan, /不把建议百分比写成 SLA/);
});

test("readiness template leaves actual budgets and environment unconfirmed", () => {
  const text = readFileSync("docs/RESEARCH-READINESS.md", "utf8");
  const rows = text.split("\n").filter(line => line.startsWith("|") && line.includes("待确认"));
  assert.ok(rows.length >= 20);
  for (const label of ["本次候选版本与 SHA-256", "专用可中断宿主及操作者", "允许的操作耗时及统计口径", "允许的事件循环阻塞预算及测量方法", "样本矩阵、重复次数、配对顺序"]) {
    const row = text.split("\n").find(line => line.startsWith("|" + label + "|"));
    assert.ok(row?.includes("待确认"), label);
  }
  assert.match(text, /不自动放行真实操作/);
  assert.match(text, /不沿用公开包哈希/);
  assert.match(text, /不能相加或从操作耗时相减/);
  assert.match(text, /保持 pending/);
  assert.match(text, /不构成发布授权/);
  assert.match(text, /它们不随 npm 包分发/);
});
