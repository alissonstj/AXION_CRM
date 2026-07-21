// Payloads for exercising EvolutionProvider.parseWebhook. Not all of
// equal confidence — see docs/superpowers/specs/2026-07-12-evolution-api-phase-2-design.md
// "Riscos remanescentes" and the Task 4 brief for the full breakdown:
//
//   Live-captured (real structure, from a real connected WhatsApp
//   account during design): TEXT_INBOUND_SAMPLE, FROM_ME_ECHO_SAMPLE,
//   IMAGE_INBOUND_SAMPLE, AUDIO_INBOUND_SAMPLE, VIDEO_GROUP_SAMPLE,
//   CONNECTION_UPDATE_ERROR_SAMPLE, REPLY_INBOUND_SAMPLE (2026-07-14,
//   pulled from the connected instance's own message history —
//   `contextInfo` confirmed as a top-level sibling of `message`, not
//   nested inside it).
//
//   Documented from the upstream Baileys/Evolution source, NOT
//   live-captured — lower confidence, same tier as the sendMedia DTO
//   correction in Task 2: DOCUMENT_INBOUND_SAMPLE, LOCATION_INBOUND_SAMPLE,
//   REACTION_INBOUND_SAMPLE, BUTTON_REPLY_INBOUND_SAMPLE, STICKER_INBOUND_SAMPLE.
//
// Phone numbers/names anonymized; base64 truncated to a short valid
// placeholder (the real captured lengths were in the hundreds of KB —
// not needed to exercise the mapping logic). E2E crypto fields
// (messageSecret, recipientKeyHash) stripped — not read by parseWebhook.

export const TEXT_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: {
      remoteJid: '5511900000002@s.whatsapp.net',
      remoteJidAlt: '5511900000002@s.whatsapp.net',
      fromMe: false,
      id: 'ANON0000000000000000000000000001',
      participant: '',
      addressingMode: 'lid',
    },
    pushName: 'Test Customer',
    message: { conversation: 'Oiiiii teste' },
    messageType: 'conversation',
    messageTimestamp: 1783887066,
  },
};

/** A real quoted-reply message, structure pulled from the connected
 *  instance's own message history 2026-07-14. `contextInfo.stanzaId`
 *  is the quoted message's WhatsApp id — a sibling of `message`, not
 *  nested inside it. */
export const REPLY_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: {
      remoteJid: '5511900000002@s.whatsapp.net',
      fromMe: false,
      id: 'ANON0000000000000000000000000005',
      participant: '',
    },
    pushName: 'Test Customer',
    message: { conversation: 'claro, aqui esta a resposta' },
    messageType: 'conversation',
    messageTimestamp: 1783887200,
    contextInfo: {
      stanzaId: 'ANON0000000000000000000000000001',
      participant: '5511900000001@s.whatsapp.net',
      quotedMessage: { conversation: 'pergunta original' },
    },
  },
};

export const FROM_ME_ECHO_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: {
      remoteJid: '5511900000001@s.whatsapp.net',
      fromMe: true,
      id: 'ANON0000000000000000000000000000',
      participant: '',
    },
    pushName: 'Test Agent',
    message: { conversation: 'Teste' },
    messageType: 'conversation',
    messageTimestamp: 1783886962,
  },
};

export const IMAGE_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: {
      remoteJid: '5511900000002@s.whatsapp.net',
      fromMe: false,
      id: 'ANON00000000000000000000000000AA',
      participant: '',
    },
    pushName: 'Test Customer',
    message: {
      imageMessage: { mimetype: 'image/jpeg', caption: 'olha isso' },
      base64: 'ZmFrZS1pbWFnZS1ieXRlcw==',
    },
    messageType: 'imageMessage',
    messageTimestamp: 1783888781,
  },
};

export const AUDIO_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: {
      remoteJid: '5511900000002@s.whatsapp.net',
      fromMe: false,
      id: 'ANON00000000000000000000000000BB',
      participant: '',
    },
    pushName: 'Test Customer',
    message: {
      audioMessage: { mimetype: 'audio/ogg; codecs=opus' },
      base64: 'ZmFrZS1hdWRpby1ieXRlcw==',
    },
    messageType: 'audioMessage',
    messageTimestamp: 1783888774,
  },
};

/** Documented from the upstream Baileys `stickerMessage` type, NOT
 *  live-captured — same confidence tier as DOCUMENT_INBOUND_SAMPLE/
 *  LOCATION_INBOUND_SAMPLE. Stickers are typically image/webp. */
export const STICKER_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: {
      remoteJid: '5511900000002@s.whatsapp.net',
      fromMe: false,
      id: 'ANON00000000000000000000000000CC',
      participant: '',
    },
    pushName: 'Test Customer',
    message: {
      stickerMessage: { mimetype: 'image/webp' },
      base64: 'ZmFrZS1zdGlja2VyLWJ5dGVz',
    },
    messageType: 'stickerMessage',
    messageTimestamp: 1783888790,
  },
};

export const VIDEO_GROUP_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: {
      remoteJid: '120363427655738502@g.us',
      fromMe: false,
      id: 'ANON00000000000000000000000000CC',
      participant: '77193514381384@lid',
      participantAlt: '5511900000003@s.whatsapp.net',
      addressingMode: 'lid',
    },
    pushName: 'Group Member',
    message: {
      videoMessage: { mimetype: 'video/mp4' },
      base64: 'ZmFrZS12aWRlby1ieXRlcw==',
    },
    messageType: 'videoMessage',
    messageTimestamp: 1783888117,
  },
};

export const DOCUMENT_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: { remoteJid: '5511900000002@s.whatsapp.net', fromMe: false, id: 'ANON00000000000000000000000000DD', participant: '' },
    pushName: 'Test Customer',
    message: {
      documentMessage: { mimetype: 'application/pdf', fileName: 'contrato.pdf' },
      base64: 'ZmFrZS1kb2MtYnl0ZXM=',
    },
    messageType: 'documentMessage',
    messageTimestamp: 1783888900,
  },
};

export const LOCATION_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: { remoteJid: '5511900000002@s.whatsapp.net', fromMe: false, id: 'ANON00000000000000000000000000EE', participant: '' },
    pushName: 'Test Customer',
    message: {
      locationMessage: { degreesLatitude: -23.55, degreesLongitude: -46.63, name: 'Praça da Sé', address: 'São Paulo, SP' },
    },
    messageType: 'locationMessage',
    messageTimestamp: 1783888950,
  },
};

export const REACTION_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: { remoteJid: '5511900000002@s.whatsapp.net', fromMe: false, id: 'ANON00000000000000000000000000FF', participant: '' },
    pushName: 'Test Customer',
    message: {
      reactionMessage: { key: { id: 'ANON0000000000000000000000000001' }, text: '👍' },
    },
    messageType: 'reactionMessage',
    messageTimestamp: 1783889000,
  },
};

export const BUTTON_REPLY_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: { remoteJid: '5511900000002@s.whatsapp.net', fromMe: false, id: 'ANON00000000000000000000000000GG', participant: '' },
    pushName: 'Test Customer',
    message: { buttonsResponseMessage: { selectedButtonId: 'btn-1', selectedDisplayText: 'Sim' } },
    messageType: 'buttonsResponseMessage',
    messageTimestamp: 1783889100,
  },
};

export const CONNECTION_UPDATE_ERROR_SAMPLE = {
  event: 'connection.update',
  instance: 'axion-test',
  data: { instance: 'axion-test', state: 'refused', statusReason: 428 },
};

// ---- LID addressing (WhatsApp's newer @lid identifier) ----
// Real shape captured 2026-07-16 from the connected instance: recent
// inbound messages arrive keyed by @lid, but carry the real phone JID
// in `remoteJidAlt`. The CRM must resolve the phone from the alt, never
// treat the LID digits as a phone number.

/** LID-addressed inbound that DOES carry the phone in remoteJidAlt —
 *  the common live case. `from` must resolve to the alt's phone. */
export const LID_WITH_ALT_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: {
      remoteJid: '224876350689405@lid',
      remoteJidAlt: '556183565665@s.whatsapp.net',
      fromMe: false,
      id: 'ANON00000000000000000000000000E1',
      participant: '',
      addressingMode: 'lid',
    },
    pushName: 'Cliente Real',
    message: { conversation: 'ola via lid' },
    messageType: 'conversation',
    messageTimestamp: 1784161200,
  },
};

/** LID-addressed inbound with NO phone alt — only the LID is known.
 *  Per the approved design ("só telefone real, ocultar LID") this
 *  message has no resolvable phone and must be dropped, never ingested
 *  under the LID digits. */
export const LID_NO_ALT_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: {
      remoteJid: '175441461657751@lid',
      fromMe: false,
      id: 'ANON00000000000000000000000000E2',
      participant: '',
      addressingMode: 'lid',
    },
    pushName: '',
    message: { conversation: 'mensagem so com lid' },
    messageType: 'conversation',
    messageTimestamp: 1784161300,
  },
};

/** WhatsApp Channel / newsletter broadcast — leaks in as a "contact"
 *  today because only @g.us is filtered. Must be skipped like groups. */
export const NEWSLETTER_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: {
      remoteJid: '120363225660181599@newsletter',
      fromMe: false,
      id: 'ANON00000000000000000000000000E3',
      participant: '',
    },
    pushName: 'iFood',
    message: { conversation: 'promo do dia' },
    messageType: 'conversation',
    messageTimestamp: 1784161400,
  },
};
