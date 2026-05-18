import type { ClipData } from '@/lib/types';

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function exportClipsJson(clips: ClipData[]): void {
  const payload = { version: 1, exportedAt: new Date().toISOString(), clips };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `discerned-clips-${todayString()}.json`);
}

export function exportClipsCsv(clips: ClipData[]): void {
  const header = 'title,url,category,interest,ethics,note,date';
  const rows = clips.map((c) => {
    const fields = [
      c.capture.title ?? '',
      c.capture.url ?? '',
      c.evaluation.category ?? '',
      c.evaluation.interest ?? '',
      c.evaluation.ethics ?? '',
      c.capture.note ?? '',
      new Date(c.capture.timestamp).toISOString(),
    ];
    return fields.map(csvField).join(',');
  });
  const csv = [header, ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, `discerned-clips-${todayString()}.csv`);
}
