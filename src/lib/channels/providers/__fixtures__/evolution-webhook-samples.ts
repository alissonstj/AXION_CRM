// Real payloads captured from a live Evolution API v2 instance (see
// docs/superpowers/specs/2026-07-12-evolution-api-phase-2-design.md).
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
