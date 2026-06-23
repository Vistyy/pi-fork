import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { aggregateInclusiveCost, formatForkCostStatus } from "./core/cost.js";
import { loadConfig } from "./config.js";
import { registerForkTool } from "./tool.js";

const FORK_COST_STATUS_KEY = "fork-cost";

function updateForkCostStatus(ctx: ExtensionContext): void {
  if (!loadConfig(ctx.cwd).costFooter) {
    ctx.ui.setStatus(FORK_COST_STATUS_KEY, undefined);
    return;
  }

  const stats = aggregateInclusiveCost(ctx.sessionManager.getEntries());
  const status = formatForkCostStatus(stats);
  ctx.ui.setStatus(FORK_COST_STATUS_KEY, status ? ctx.ui.theme.fg("dim", status) : undefined);
}

export { resolveModelContextWindow } from "./tool.js";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    updateForkCostStatus(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    updateForkCostStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    updateForkCostStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(FORK_COST_STATUS_KEY, undefined);
  });

  registerForkTool(pi);
}
