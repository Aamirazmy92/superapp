import { memo, useEffect, useState } from 'react';
import { FileText, X } from './icons';
import type { ChatAttachment, ChatAttachmentInput } from './types';

const images: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const previews = new Map<string, Promise<string>>();
function preview(file: ChatAttachment) {
  if (!previews.has(file.id)) {
    if (previews.size >= 16) previews.delete(previews.keys().next().value!);
    previews.set(
      file.id,
      window
        .workspace!.chatReadAttachment(file.id)
        .then((value) => `data:${value.mimeType};base64,${value.data}`),
    );
  }
  return previews.get(file.id)!;
}
export async function readAttachment(file: File): Promise<ChatAttachmentInput> {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const mimeType =
    images[extension] || (Object.values(images).includes(file.type) ? file.type : 'text/plain');
  const kind = mimeType.startsWith('image/') ? 'image' : 'text';
  if (!file.size || file.size > (kind === 'image' ? 5 : 1) * 1024 * 1024)
    throw new Error(
      `${file.name}: ${kind === 'image' ? 'images must be under 5 MB' : 'text files must be under 1 MB'}.`,
    );
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error(`Unable to read ${file.name}.`));
    reader.readAsDataURL(file);
  });
  return { name: file.name, kind, mimeType, data };
}
const Attachment = memo(function Attachment({
  file,
  onRemove,
}: {
  file: ChatAttachment;
  onRemove?(id: string): void;
}) {
  const [url, setURL] = useState('');
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (file.kind !== 'image') return;
    let current = true;
    preview(file)
      .then((value) => {
        if (current) setURL(value);
      })
      .catch(() => {
        if (current) setMissing(true);
      });
    return () => {
      current = false;
    };
  }, [file.id, file.kind]);
  return (
    <div className={`chat-attachment ${file.kind}`} title={file.name}>
      {file.kind === 'image' && url ? (
        <img src={url} alt={file.name} loading="lazy" />
      ) : (
        <FileText size={18} aria-hidden="true" />
      )}
      <span>
        <strong>{file.name}</strong>
        <small>
          {missing
            ? 'Image unavailable'
            : `${file.kind === 'image' ? 'Image' : 'File'} · ${Math.max(1, Math.round(file.size / 1024))} KB`}
        </small>
      </span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove attachment ${file.name}`}
          onClick={() => onRemove(file.id)}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
});
export default memo(function ChatAttachments({
  files,
  onRemove,
}: {
  files: ChatAttachment[];
  onRemove?(id: string): void;
}) {
  return (
    <div className="chat-attachments">
      {files.map((file) => (
        <Attachment key={file.id} file={file} onRemove={onRemove} />
      ))}
    </div>
  );
});
