import { Service } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";

/**
 * Register the real prompt service AND run its init hook. A bare constructor
 * registers the service without running [Service.init]; a turn then assembles a
 * prompt against an unpublished session admission. This is a fixture concern,
 * not a host contract: the installed host mounts the service as a plugin.
 */
export async function mountSystemPrompt(ctx, config = {}) {
  const prompt = new SystemPrompt(ctx, config);
  await prompt[Service.init]?.();
  return prompt;
}
