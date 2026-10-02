import { Component, type ReactNode } from 'react';
export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="browser-notice">
          <h1>Workspace could not be displayed</h1>
          <p>Reload to restore your last saved workspace. Your files on disk are unchanged.</p>
          <button
            className="primary-button"
            onClick={() => window.workspace?.windowAction('reload')}
          >
            Reload workspace
          </button>
          <button
            className="text-button"
            onClick={() => window.workspace?.windowAction('close-ready')}
          >
            Close app
          </button>
        </main>
      );
    return this.props.children;
  }
}
