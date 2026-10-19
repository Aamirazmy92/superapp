// Turns files and images dropped on a terminal into paths to type into it.
// Agent CLIs (Claude Code, Codex) attach an image when its path is pasted,
// the same as dropping it on a regular terminal window.

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;

export type DroppedItems = {
  files: File[];
  uriList: string;
  html: string;
};

type DropApi = {
  pathForFile(file: File): string;
  saveDroppedImage(image: { name: string; data: string }): Promise<string>;
  downloadDroppedImage(url: string): Promise<string>;
};

/** Whether a drag carries anything a terminal drop can use. */
export function acceptsDrop(types: readonly string[]) {
  return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/html');
}

/** Copies what a drop event carries; the DataTransfer is emptied once the handler returns. */
export function readDrop(transfer: DataTransfer): DroppedItems {
  return {
    files: Array.from(transfer.files),
    uriList: transfer.getData('text/uri-list'),
    html: transfer.getData('text/html'),
  };
}

/**
 * What reads the pasted path: an agent's prompt, or a shell that will run
 * the line once Enter is pressed.
 */
export type PasteTarget = 'agent' | 'powershell' | 'cmd' | 'posix';

/** The paste target for a terminal, from its shell and agent. */
export function pasteTarget(shell: string, agentId?: string): PasteTarget {
  if (agentId && agentId !== 'terminal') return 'agent';
  if (shell === 'powershell') return 'powershell';
  if (shell === 'cmd') return 'cmd';
  return 'posix';
}

/**
 * Quotes a dropped path for the terminal it is pasted into, so that a file
 * name can never run a command: shells get quoting that expands nothing,
 * agents get double quotes the way Windows Terminal drops files.
 */
export function quotePath(filePath: string, target: PasteTarget = 'agent') {
  const refuse = () => {
    throw new Error(`${filePath.replace(/[\x00-\x1f\x7f-\x9f]/g, '?')} cannot be pasted into this terminal safely. Rename it first.`);
  };
  if (/[\x00-\x1f\x7f-\x9f]/.test(filePath)) refuse();
  if (target === 'powershell')
    return /^[\w\\/:.\-]+$/.test(filePath) ? filePath : `'${filePath.replace(/['‘’‚‛]/g, '$&$&')}'`;
  if (target === 'posix')
    return /^[\w/.\-]+$/.test(filePath) ? filePath : `'${filePath.replace(/'/g, "'\\''")}'`;
  // Command Prompt expands %VAR% (and !VAR! with delayed expansion) even inside quotes.
  if (target === 'cmd' && /[%!]/.test(filePath)) refuse();
  return /[\s"&'()^;,`]/.test(filePath) ? `"${filePath.replace(/"/g, '')}"` : filePath;
}

/**
 * The address of an image dragged out of a web page: the <img> it came from,
 * or a link straight to an image file. Plain links are not images.
 */
export function droppedImageAddress({ uriList, html }: Pick<DroppedItems, 'uriList' | 'html'>) {
  const source = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
  const image = (source?.[1] ?? source?.[2] ?? source?.[3] ?? '').replace(/&amp;/g, '&');
  const link = uriList.split(/\r?\n/).find((line) => line.trim() && !line.startsWith('#'))?.trim() ?? '';
  const candidates = [
    { address: image, isImage: true },
    { address: link, isImage: false },
  ];
  for (const { address, isImage } of candidates) {
    if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(address)) return address;
    try {
      const url = new URL(address);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && (isImage || IMAGE_NAME.test(url.pathname)))
        return url.href;
    } catch {
      // Empty, relative or malformed addresses can't be fetched.
    }
  }
  return '';
}

function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error(`${file.name} could not be read.`));
    reader.readAsDataURL(file);
  });
}

/** Paths for everything dropped, saving images that have no file of their own first. */
export async function resolveDrop(items: DroppedItems, api: DropApi): Promise<string[]> {
  const paths: string[] = [];
  for (const file of items.files) {
    const filePath = api.pathForFile(file);
    if (filePath) {
      paths.push(filePath);
      continue;
    }
    // A file with no path on disk, e.g. an image dragged from a browser.
    if (!file.type.startsWith('image/') && !IMAGE_NAME.test(file.name)) continue;
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name}: dropped images must be under 20 MB.`);
    paths.push(await api.saveDroppedImage({ name: file.name, data: await fileBase64(file) }));
  }
  if (paths.length) return paths;
  const address = droppedImageAddress(items);
  if (!address) return [];
  if (address.startsWith('data:'))
    return [await api.saveDroppedImage({ name: 'image', data: address.slice(address.indexOf(',') + 1) })];
  return [await api.downloadDroppedImage(address)];
}
