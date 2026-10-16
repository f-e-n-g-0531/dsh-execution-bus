import type { Context } from "@deepseek-ai/cordis";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { apply as applyBus } from "./plugin.js";
export const name = "execution-bus-test-mode"; // legacy export identity, intentionally stable
export const inject = ["tools", "jobs", "systemPrompt"];
/** An additive preset row: presentation, tool inventory and authority belong to the host PTC composition. */
export function apply(ctx: Context) {
  if (scopeOf(ctx) === undefined)
    throw Error("Xiao He mode requires an Agent preset scope");
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: "XIAO_HE_EXECUTION_BUS",
      order: 1700,
      text: "你正在萧何模式中。这不是角色扮演。保留宿主 PTC 的日常工具能力与权限规则。普通编辑、搜索、命令、安装和其他工作使用原工具，不要声称此模式只读。execution_bus 是可选协调入口，目前只支持 test 与 host.read，不支持任意命令，不要强制所有任务走总线。通过 run_code 调用 await tools.execution_bus(...)，受原有时间预算约束。总线请求只提交一次并等待结果，不循环查询；同一逻辑操作重发沿用 requestId。cancelRequested 不等于已取消，unknown 不代表执行失败，不承诺跨重启恢复。后台命令仅返回 Job ID 不代表命令已经完成。",
    }),
  );
  applyBus(ctx);
}
