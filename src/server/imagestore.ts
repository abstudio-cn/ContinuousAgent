/** 工具产生的截图小仓库：SSE 只发 URL，避免整张 base64 挤进事件流。 */
const MAX_ITEMS = 24;
const items = new Map<string, { data: Buffer; mime: string; at: number }>();

export function putImage(base64: string, mime = 'image/jpeg'): string {
  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  items.set(id, { data: Buffer.from(base64, 'base64'), mime, at: Date.now() });
  while (items.size > MAX_ITEMS) {
    const oldest = items.keys().next().value as string | undefined;
    if (!oldest) break;
    items.delete(oldest);
  }
  return '/api/images/' + id;
}

export function getImage(id: string): { data: Buffer; mime: string } | null {
  const hit = items.get(id);
  return hit ? { data: hit.data, mime: hit.mime } : null;
}
