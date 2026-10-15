import { useEffect, useState } from 'react';
import type { PluginContributions } from './types';

const empty: PluginContributions = { commands: [], agents: [], prompts: [], themes: [] };

/*
 * The contributions of the plugins that apply to a project. Reloads whenever a
 * plugin is installed, enabled, disabled, updated or removed, so they appear and
 * disappear without a restart.
 */
export function usePluginContributions(projectId: string | null | undefined) {
  const [contributions, setContributions] = useState<PluginContributions>(empty);
  useEffect(() => {
    const api = window.workspace;
    if (!api?.pluginsContributions) return;
    let canceled = false;
    let version = 0;
    const load = () => {
      const current = ++version;
      api
        .pluginsContributions(projectId ?? null)
        .then((value) => {
          if (!canceled && current === version) setContributions(value);
        })
        .catch(() => {
          if (!canceled && current === version) setContributions(empty);
        });
    };
    load();
    const stop = api.onPluginsChanged(load);
    return () => {
      canceled = true;
      stop();
    };
  }, [projectId]);
  return contributions;
}
