// Terminal based agents do not expose a shared reply-completed event. Agent
// CLIs animate a spinner while they work, so a quiet period marks the reply
// as done.
export const AGENT_RESPONSE_SETTLE_MS = 8_000;
// Output this soon after a keystroke is the agent echoing what was typed.
export const AGENT_INPUT_ECHO_MS = 1_500;

export type AgentTurn = {
  submittedAt: number;
  lastOutputAt: number;
  completedAt?: number;
  // Last keystroke after the turn completed, such as answering a permission
  // prompt without pressing Enter.
  touchedAt?: number;
};

// Returns true when the output moves a finished turn back to working.
export function recordAgentOutput(turn: AgentTurn, at: number): boolean {
  if (at < turn.submittedAt) return false;
  if (turn.completedAt !== undefined) {
    // A finished agent still redraws when its pane is resized or focused.
    // Only output that outlasts the echo of a keystroke the user sent after
    // the reply finished means the agent is working again.
    if (turn.touchedAt === undefined || at - turn.touchedAt < AGENT_INPUT_ECHO_MS) return false;
    turn.completedAt = undefined;
    turn.touchedAt = undefined;
    turn.lastOutputAt = at;
    return true;
  }
  turn.lastOutputAt = Math.max(turn.lastOutputAt, at);
  return false;
}

export function recordAgentKeystroke(turn: AgentTurn, at: number) {
  if (turn.completedAt !== undefined) turn.touchedAt = at;
}

// When the turn is due to settle if nothing else is printed.
export function agentTurnSettlesAt(turn: AgentTurn) {
  return Math.max(turn.submittedAt, turn.lastOutputAt) + AGENT_RESPONSE_SETTLE_MS;
}

export function settleAgentTurn(turn: AgentTurn, now: number): boolean {
  if (turn.completedAt !== undefined || now < agentTurnSettlesAt(turn)) return false;
  turn.completedAt = agentTurnSettlesAt(turn);
  return true;
}

export type AgentStatus = 'working' | 'idle' | 'done';

// Shared by the sidebar dots and the agent dashboard so they never disagree.
export function terminalStatus(
  terminal: { exited?: boolean; lastInputAt?: number; finishedAt?: number },
  turn?: { submittedAt: number; completedAt?: number },
): AgentStatus {
  if (terminal.exited) return 'done';
  const promptedAt = Math.max(terminal.lastInputAt || 0, turn?.submittedAt || 0);
  if (!promptedAt) return 'idle';
  return terminal.finishedAt || turn?.completedAt ? 'done' : 'working';
}
