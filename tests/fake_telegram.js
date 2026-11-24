// A stand-in for the Telegram Bot API, as a fetch function.
function makeTelegram({ status = 200, updates = [], botUsername = 'bdo_test_bot', events = [] } = {}) {
  const state = { sent: [], urls: [], status, updates, events };
  const reply = (code, obj) => ({ status: code, json: async () => obj });
  async function fetch(url, opts = {}) {
    state.urls.push(url);
    if (/\/getUpdates$/.test(url)) return reply(200, { ok: true, result: state.updates });
    if (/\/getMe$/.test(url)) return reply(200, { ok: true, result: { username: botUsername } });
    state.events.push('send');
    const body = JSON.parse(opts.body);
    if (state.status === 200) {
      const m = { chat_id: String(body.chat_id), text: body.text };
      if (body.reply_markup) m.reply_markup = body.reply_markup;
      state.sent.push(m);
    }
    return reply(state.status, { ok: state.status === 200 });
  }
  return { fetch, state };
}

module.exports = { makeTelegram };
