import { useState } from 'react';
import Modal from './Modal';
import { Copy, MessageSquare, SquareTerminal } from './icons';
import { errorMessage, promptText } from './pluginModel';
import type { PluginContributions } from './types';

type Prompt = PluginContributions['prompts'][number];

/*
 * A plugin prompt or skill, shown before it goes anywhere. Its text is the
 * plugin author's, so it is only ever copied, put into a chat draft, or typed
 * into an agent without pressing Enter: the person sends it.
 */
export default function PluginPrompt({
  prompt,
  canChat,
  terminalTarget,
  onClose,
  onInsertChat,
  onTypeTerminal,
}: {
  prompt: Prompt;
  canChat: boolean;
  /** The agent terminal that would receive the text, if any. */
  terminalTarget?: string;
  onClose(): void;
  onInsertChat(text: string): void;
  onTypeTerminal(text: string): Promise<void>;
}) {
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const text = promptText(prompt.body);
  return (
    <Modal title={prompt.title} className="plugins-prompt-modal" onClose={onClose}>
      <p className="muted">
        {prompt.kind === 'skill' ? 'Skill' : 'Prompt'} from {prompt.plugin}
        {prompt.description ? ` · ${prompt.description}` : ''}
      </p>
      <pre className="plugins-prompt-body" tabIndex={0} aria-label="Prompt text">
        {text}
      </pre>
      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}
      <div className="tool-actions">
        <button
          className="primary-button"
          disabled={!canChat}
          title={canChat ? undefined : 'Open a project to use chat'}
          onClick={() => {
            onInsertChat(text);
            onClose();
          }}
        >
          <MessageSquare size={14} /> Insert into chat
        </button>
        <button
          className="secondary-button"
          disabled={!terminalTarget}
          title={terminalTarget ? `Types into ${terminalTarget} without pressing Enter` : 'Start an agent terminal first'}
          onClick={async () => {
            try {
              await onTypeTerminal(text);
              onClose();
            } catch (reason) {
              setError(errorMessage(reason));
            }
          }}
        >
          <SquareTerminal size={14} /> {terminalTarget ? `Type into ${terminalTarget}` : 'Type into agent'}
        </button>
        <button
          className="secondary-button"
          onClick={() =>
            window.workspace!
              .writeTerminalClipboard(text)
              .then(() => setCopied(true))
              .catch((reason) => setError(errorMessage(reason)))
          }
        >
          <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </Modal>
  );
}
