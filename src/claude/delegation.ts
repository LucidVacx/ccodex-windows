/**
 * Codex's `ultra` effort on Claude models: Claude's top effort plus proactive delegation to sub-agents. Stock turns the
 * delegation on and off with a mode message in the thread; its guidance lives in the spawn_agent tool, here adapted to
 * Claude Code's Agent tool.
 */

export const ULTRA = "ultra";

/** The effort Claude runs at. */
export function claudeEffort(effort: string | null): string | null {
  return effort === ULTRA ? "max" : effort;
}

export const DELEGATION_ON = `Proactive multi-agent delegation is active. Any earlier developer instruction requiring an explicit user request before spawning sub-agents no longer applies. This mode remains active until a later multi-agent mode developer message changes it. User requests override this hint.

Delegate with the Agent tool (not the Workflow tool, unless the user asks for a workflow). Sub-agents inherit your model: set \`model\` only when the user or their instructions ask for another one.

### When to delegate vs. do the subtask yourself
- First, quickly analyze the overall user task and form a succinct high-level plan. Identify which tasks are immediate blockers on the critical path, and which tasks are sidecar tasks that are needed but can run in parallel without blocking the next local step. As part of that plan, explicitly decide what immediate task you should do locally right now. Do this planning step before delegating to agents so you do not hand off the immediate blocking task to a sub-agent and then waste time waiting on it.
- Use a sub-agent when a subtask is easy enough for it to handle and can run in parallel with your local work. Prefer delegating concrete, bounded sidecar tasks that materially advance the main task without blocking your immediate next local step.
- Do not delegate urgent blocking work when your immediate next step depends on that result. If the very next action is blocked on that task, the main thread should usually do it locally to keep the critical path moving.
- Keep work local when the subtask is too difficult to delegate well and when it is tightly coupled, urgent, or likely to block your immediate next step.
### Designing delegated subtasks
- Subtasks must be concrete, well-defined, and self-contained.
- Delegated subtasks must materially advance the main task.
- Do not duplicate work between the main thread and delegated subtasks.
- Avoid issuing multiple delegate calls on the same unresolved thread unless the new delegated task is genuinely different and necessary.
- Narrow the delegated ask to the concrete output you need next.
- For coding tasks, prefer delegating concrete code-change worker subtasks over read-only explorer analysis when the sub-agent can make a bounded patch in a clear write scope.
- When delegating coding work, instruct the sub-agent to edit files directly and list the file paths it changed in the final answer.
- For code-edit subtasks, decompose work so each delegated task has a disjoint write set.
### After you delegate
- Wait for a sub-agent very sparingly. Only wait when you need the result immediately for the next critical-path step and you are blocked until it returns.
- Do not redo delegated sub-agent tasks yourself; focus on integrating results or tackling non-overlapping work.
- While the sub-agent is running in the background, do meaningful non-overlapping work immediately.
- Do not repeatedly wait by reflex.
- When a delegated coding task returns, quickly review the changes, then integrate or refine them.
### Parallel delegation patterns
- Run multiple independent information-seeking subtasks in parallel when you have distinct questions that can be answered independently.
- Split implementation into disjoint codebase slices and spawn multiple agents for them in parallel when the write scopes do not overlap.
- Delegate verification only when it can run in parallel with ongoing implementation and is likely to catch a concrete risk before final integration.
- The key is to find opportunities to spawn multiple independent subtasks in parallel within the same round, while ensuring each subtask is well-defined, self-contained, and materially advances the main task.`;

export const DELEGATION_OFF = "Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user or applicable CLAUDE.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.";
