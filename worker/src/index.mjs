// Cloudflare Worker entry. The page (on GitHub Pages) POSTs JSON here; every request is handed to
// one Durable Object so changes happen one at a time, then answered with CORS headers so the page
// can read the reply from another site.

import { DurableObject } from 'cloudflare:workers';
import { Picker } from './picker.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};
const MAX_BODY = 64 * 1024;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') {
      return new Response('BDO Picker is running.', { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    const text = await request.text();
    const out = text.length > MAX_BODY
      ? { ok: false, error: 'Something went wrong. Try again in a moment.' }
      : await env.PICKER.get(env.PICKER.idFromName('main')).post(text);
    return Response.json(out, { headers: CORS });
  },
};

export class PickerObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.picker = new Picker({ db: env.DB, env });
  }

  post(text) {
    return this.picker.post(text);
  }
}
