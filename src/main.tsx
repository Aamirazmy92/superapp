import ReactDOM from 'react-dom/client';
import '@fontsource-variable/figtree';
import App from './App';
import ErrorBoundary from './ErrorBoundary';
import './styles.css';
import './agentSetup.css';
import './noMotion.css';
import './design.css';
import './workspaceSetup.css';
import './light.css';
import './interactions.css';
import './modals.css';
import './buttons.css';
import './claude.css';
import './sidebar.css';
import './typography.css';
import './toast.css';
import './notifications.css';
import './icons.css';
import './fileEditor.css';
import './tokens.css';
import './density.css';
import './switch.css';
import './plugins.css';
import './shell.css';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
