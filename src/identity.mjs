// Only use on Sites, or behind a server that strips client identity headers.
export async function platformIdentity(request) {
  const id = request.headers.get('oai-authenticated-user-id')?.trim();
  if (id) return id;
  const email = request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
  return 'platform-email:' + Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
