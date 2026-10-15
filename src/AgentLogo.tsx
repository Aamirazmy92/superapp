import type { ReactNode } from 'react';
import { SquareTerminal } from './icons';
import claudeLogo from './assets/agents/claude.svg';
import codexLogo from './assets/agents/codex.svg';
import copilotLogo from './assets/agents/copilot.svg';
import cursorLogo from './assets/agents/cursor.svg';
import droidLogo from './assets/agents/droid.svg';
import geminiLogo from './assets/agents/gemini.svg';
import kimiLogo from './assets/agents/kimi.svg';
import kimiLightLogo from './assets/agents/kimi-light.svg';
import opencodeLogo from './assets/agents/opencode.svg';

const agentLogos: Record<string, string> = {
  claude: claudeLogo,
  codex: codexLogo,
  copilot: copilotLogo,
  cursor: cursorLogo,
  droid: droidLogo,
  gemini: geminiLogo,
  kimi: kimiLogo,
  opencode: opencodeLogo,
};

const agentMonograms: Record<string, string> = {
  aider: 'A',
  amp: 'A',
  antigravity: 'A',
  auggie: 'A',
  cline: 'C',
  crush: 'C',
  goose: 'G',
  grok: 'X',
  hermes: 'H',
  junie: 'J',
  kilo: 'K',
  kiro: 'K',
  openhands: 'O',
  pi: 'π',
  qoder: 'Q',
  qwen: 'Q',
  vibe: 'M',
};

export function hasAgentLogo(agentId?: string) {
  return !!agentId && (agentId in agentLogos || agentId in agentMonograms);
}

export default function AgentLogo({
  agentId,
  fallback,
  mark,
  size = 16,
  className = '',
}: {
  agentId?: string;
  fallback?: ReactNode;
  /** A short monogram for agents without a logo, such as plugin presets. */
  mark?: string;
  size?: number;
  className?: string;
}) {
  const logo = agentId ? agentLogos[agentId] : undefined;
  const monogram = (agentId ? agentMonograms[agentId] : undefined) ?? mark;
  return (
    <span
      className={`agent-logo ${agentId ? `agent-logo-${agentId}` : ''} ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {logo ? (
        agentId === 'kimi' ? (
          <>
            <img className="agent-logo-kimi-dark" src={logo} alt="" draggable={false} />
            <img className="agent-logo-kimi-light" src={kimiLightLogo} alt="" draggable={false} />
          </>
        ) : (
          <img src={logo} alt="" draggable={false} />
        )
      ) : monogram ? (
        <span className="agent-monogram" style={{ fontSize: Math.round(size * 0.62) }}>
          {monogram}
        </span>
      ) : (
        (fallback ?? <SquareTerminal size={Math.round(size * 0.9)} />)
      )}
    </span>
  );
}
