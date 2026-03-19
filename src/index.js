import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Keyboard, VK } from 'vk-io';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.resolve(__dirname, '../data/state.json');

const VK_TOKEN = process.env.VK_TOKEN;
if (!VK_TOKEN) {
  throw new Error('VK_TOKEN is required in .env');
}
const VK_USER_TOKEN = process.env.VK_USER_TOKEN;
const DEBUG_EVENTS = process.env.DEBUG_EVENTS === '1';

const vk = new VK({ token: VK_TOKEN });
const vkUser = VK_USER_TOKEN ? new VK({ token: VK_USER_TOKEN }) : null;

const ACTIONS = {
  PAY_SELF: 'pay_self',
  PAY_INVITED: 'pay_invited'
};
const GAME_POLL_ANSWERS = ['Иду', '+1', '+2', '+3', 'Не иду'];
const POLL_BACKGROUND_IDS = new Set(['0', '1', '2', '3', '4', '6', '8', '9']);
const HELP_TEXT = [
  'Команды бота:',
  '/ping - проверка, что бот онлайн',
  '/createGame <название> - создать игровой опрос',
  '/getMoney <текст_оплаты> - запустить сбор по опросу (команду отправлять ответом на сообщение с опросом)',
  '',
  'Как пользоваться:',
  '1) Создайте опрос через /createGame (или используйте уже готовый).',
  '2) Когда игра прошла, ответьте на сообщение с опросом командой /getMoney.',
  '3) Участники нажимают "Оплатил", а пригласившие используют "Оплатил приглашенный".'
].join('\n');

let state = { collections: {} };
let cachedGreenBackgroundId = null;

async function ensureStateLoaded() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    state = JSON.parse(raw);
    if (!state.collections || typeof state.collections !== 'object') {
      state.collections = {};
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      await saveState();
      return;
    }

    throw error;
  }
}

async function saveState() {
  await fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function parseGetMoneyCommand(text) {
  const match = text.match(/^\/getmoney\s+(.+)$/i);
  if (!match) {
    return null;
  }

  return {
    paymentText: match[1].trim()
  };
}

function parseCreateGameCommand(text) {
  const match = text.match(/^\/creategame\s+(.+)$/i);
  if (!match) {
    return null;
  }

  return {
    title: match[1].trim()
  };
}

function extractPollAttachment(message) {
  if (!message || !Array.isArray(message.attachments)) {
    return null;
  }

  const pollAttachment = message.attachments.find((attachment) => attachment.type === 'poll');
  return pollAttachment?.poll ?? null;
}

function extractPositiveInteger(optionText) {
  const match = optionText.trim().match(/^\+(\d+)$/);
  if (!match) {
    return 0;
  }

  return Number(match[1]);
}

function isGoingOption(optionText) {
  return optionText.trim().toLowerCase() === 'иду';
}

function normalizeVotersResponse(response) {
  const normalized = {};

  if (!Array.isArray(response)) {
    return normalized;
  }

  for (const answerBlock of response) {
    if (!answerBlock || typeof answerBlock.answer_id === 'undefined') {
      continue;
    }

    const answerId = Number(answerBlock.answer_id);
    const usersData = answerBlock.users;
    const items = usersData?.items ?? usersData ?? [];

    if (Array.isArray(items)) {
      normalized[answerId] = items.filter((id) => typeof id === 'number');
    }
  }

  return normalized;
}

async function getPollVotersByAnswer(poll) {
  if (!vkUser) {
    const error = new Error('VK_USER_TOKEN is required to read poll voters via polls.getVoters');
    error.code = 'MISSING_USER_TOKEN';
    throw error;
  }

  const answerIds = (poll.answers ?? []).map((answer) => answer.id);
  if (answerIds.length === 0) {
    return {};
  }

  const raw = await vkUser.api.polls.getVoters({
    owner_id: poll.owner_id,
    poll_id: poll.id,
    answer_ids: answerIds.join(',')
  });

  return normalizeVotersResponse(raw);
}

function parseHexColor(hex) {
  const value = String(hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) {
    return null;
  }

  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16)
  };
}

function getGreenScore(hex) {
  const rgb = parseHexColor(hex);
  if (!rgb) {
    return Number.NEGATIVE_INFINITY;
  }

  // Prefer colors where green channel dominates and is bright enough.
  return (rgb.g - rgb.r) + (rgb.g - rgb.b) + (rgb.g * 0.25);
}

function pickGreenBackgroundId(backgrounds) {
  let bestId = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const background of backgrounds ?? []) {
    const id = String(background?.id ?? '');
    if (!POLL_BACKGROUND_IDS.has(id)) {
      continue;
    }

    const colors = [
      background?.color,
      ...(background?.points ?? []).map((point) => point?.color)
    ];
    const localBest = Math.max(...colors.map(getGreenScore));

    if (localBest > bestScore) {
      bestScore = localBest;
      bestId = id;
    }
  }

  return bestId;
}

async function resolveGreenBackgroundId() {
  if (cachedGreenBackgroundId) {
    return cachedGreenBackgroundId;
  }

  if (!vkUser) {
    return null;
  }

  try {
    const backgrounds = await vkUser.api.polls.getBackgrounds({});
    cachedGreenBackgroundId = pickGreenBackgroundId(backgrounds);
    return cachedGreenBackgroundId;
  } catch {
    return null;
  }
}

async function createGamePoll(title) {
  if (!vkUser) {
    const error = new Error('VK_USER_TOKEN is required to create poll via polls.create');
    error.code = 'MISSING_USER_TOKEN';
    throw error;
  }

  const greenBackgroundId = await resolveGreenBackgroundId();
  const poll = await vkUser.api.polls.create({
    question: title,
    add_answers: JSON.stringify(GAME_POLL_ANSWERS),
    is_anonymous: 0,
    is_multiple: 1,
    disable_unvote: 0,
    ...(greenBackgroundId ? { background_id: greenBackgroundId } : {})
  });

  return `poll${poll.owner_id}_${poll.id}`;
}

function buildUnpaidParticipants({ poll, votersByAnswer }) {
  const unpaidSelf = new Set();
  const invitedByUser = {};

  for (const answer of poll.answers ?? []) {
    const answerId = Number(answer.id);
    const answerText = String(answer.text ?? '').trim();
    const voters = votersByAnswer[answerId] ?? [];

    if (isGoingOption(answerText)) {
      for (const userId of voters) {
        unpaidSelf.add(userId);
      }
      continue;
    }

    const invitedCount = extractPositiveInteger(answerText);
    if (invitedCount <= 0) {
      continue;
    }

    for (const userId of voters) {
      invitedByUser[userId] = (invitedByUser[userId] ?? 0) + invitedCount;
    }
  }

  return {
    unpaidSelf: Array.from(unpaidSelf),
    invitedByUser
  };
}

async function getUsersMap(userIds) {
  const ids = Array.from(new Set(userIds));
  if (ids.length === 0) {
    return {};
  }

  const users = await vk.api.users.get({ user_ids: ids.join(',') });
  const map = {};

  for (const user of users) {
    map[user.id] = `${user.first_name} ${user.last_name}`;
  }

  return map;
}

function makeMention(userId, usersMap) {
  const fallback = `id${userId}`;
  return `[id${userId}|${usersMap[userId] ?? fallback}]`;
}

function renderCollectionMessage(collection, usersMap) {
  const pollTitle = collection.pollTitle ?? 'Без названия';
  const paymentText = collection.paymentText ?? '';
  const lines = [];
  lines.push(`Сбор за игру: ${pollTitle}`);
  if (paymentText) {
    lines.push(paymentText);
  }
  lines.push('');
  lines.push('Не оплатили:');

  const selfIds = [...collection.unpaidSelf].sort((a, b) => a - b);
  for (const userId of selfIds) {
    lines.push(`• ${makeMention(userId, usersMap)}`);
  }

  const invitedEntries = Object.entries(collection.invitedByUser)
    .map(([userId, count]) => [Number(userId), Number(count)])
    .filter(([, count]) => count > 0)
    .sort((a, b) => a[0] - b[0]);

  for (const [userId, count] of invitedEntries) {
    for (let i = 1; i <= count; i += 1) {
      lines.push(`• ${makeMention(userId, usersMap)} + приглашенный ${i}`);
    }
  }

  if (selfIds.length === 0 && invitedEntries.length === 0) {
    lines.push('• Все оплатили');
  }

  return lines.join('\n');
}

function buildKeyboard(collectionId) {
  return Keyboard.builder()
    .inline()
    .callbackButton({
      label: 'Оплатил',
      payload: {
        action: ACTIONS.PAY_SELF,
        collectionId
      },
      color: 'positive'
    })
    .row()
    .callbackButton({
      label: 'Оплатил приглашенный',
      payload: {
        action: ACTIONS.PAY_INVITED,
        collectionId
      },
      color: 'secondary'
    });
}

async function safeShowSnackbar(context, text) {
  try {
    await context.answer({
      type: 'show_snackbar',
      text
    });
    return true;
  } catch {
    return false;
  }
}

async function acknowledgeEvent(context) {
  // Callback button spinner in VK stops only after sendMessageEventAnswer.
  const ok = await safeShowSnackbar(context, 'Обрабатываю...');
  if (!ok) {
    console.error('Failed to acknowledge callback event', {
      peerId: context.peerId,
      userId: context.userId,
      eventId: context.eventId
    });
  }
}

async function refreshCollectionMessage(collection) {
  const userIds = [
    ...collection.unpaidSelf,
    ...Object.keys(collection.invitedByUser).map((id) => Number(id))
  ];
  const usersMap = await getUsersMap(userIds);
  const message = renderCollectionMessage(collection, usersMap);

  const conversationMessageId = Number(collection.conversationMessageId ?? 0);
  const messageId = Number(collection.messageId ?? 0);
  if (conversationMessageId <= 0 && messageId <= 0) {
    throw new Error('Collection message ids are missing');
  }

  const target = conversationMessageId > 0
    ? { conversation_message_id: conversationMessageId }
    : { message_id: messageId };

  await vk.api.messages.edit({
    peer_id: collection.peerId,
    ...target,
    message,
    keyboard: buildKeyboard(collection.id)
  });
}

vk.updates.on('message_new', async (context, next) => {
  if (!context.text) {
    return next();
  }

  if (context.text.trim().toLowerCase() === '/ping') {
    await context.send('pong');
    return;
  }

  if (context.text.trim().toLowerCase() === '/help') {
    await context.send(HELP_TEXT);
    return;
  }

  const createGame = parseCreateGameCommand(context.text.trim());
  if (createGame) {
    if (!createGame.title) {
      await context.send('После /createGame укажите название, например: /createGame Волейбол в четверг');
      return;
    }

    try {
      const attachment = await createGamePoll(createGame.title);
      await context.send({
        message: `Опрос создан: ${createGame.title}`,
        attachment
      });
    } catch (error) {
      if (error?.code === 'MISSING_USER_TOKEN') {
        await context.send(
          'Для создания опроса нужен user-токен. Добавьте VK_USER_TOKEN в .env и перезапустите бота.'
        );
        return;
      }

      console.error('Failed to create game poll', {
        code: error?.code,
        message: error?.message
      });
      await context.send('Не получилось создать опрос. Проверьте VK_USER_TOKEN и попробуйте снова.');
    }

    return;
  }

  const parsed = parseGetMoneyCommand(context.text.trim());
  if (!parsed) {
    return next();
  }
  if (!parsed.paymentText) {
    await context.send('После /getMoney укажите текст, например: /getMoney 500р на 8-999-123-45-67');
    return;
  }

  const replyMessage = context.message.reply_message;
  if (!replyMessage) {
    await context.send('Команду /getMoney нужно отправить ответом на сообщение с опросом.');
    return;
  }

  const poll = extractPollAttachment(replyMessage);
  if (!poll) {
    await context.send('В сообщении, на которое вы ответили, не найден опрос.');
    return;
  }

  try {
    const votersByAnswer = await getPollVotersByAnswer(poll);
    const participants = buildUnpaidParticipants({ poll, votersByAnswer });

    const userIds = [
      ...participants.unpaidSelf,
      ...Object.keys(participants.invitedByUser).map((id) => Number(id))
    ];
    const usersMap = await getUsersMap(userIds);

    const collectionId = `${context.peerId}_${Date.now()}`;
    const draftCollection = {
      id: collectionId,
      peerId: context.peerId,
      paymentText: parsed.paymentText,
      pollTitle: String(poll.question ?? 'Без названия'),
      poll: {
        ownerId: poll.owner_id,
        pollId: poll.id
      },
      unpaidSelf: participants.unpaidSelf,
      invitedByUser: participants.invitedByUser,
      createdAt: new Date().toISOString()
    };

    const message = renderCollectionMessage(draftCollection, usersMap);
    const sent = await context.send({
      message,
      keyboard: buildKeyboard(collectionId)
    });

    const collection = {
      ...draftCollection,
      messageId: Number(sent?.id ?? 0),
      conversationMessageId: Number(sent?.conversationMessageId ?? 0)
    };

    state.collections[collectionId] = collection;
    await saveState();
  } catch (error) {
    if (error?.code === 'MISSING_USER_TOKEN') {
      await context.send(
        'Для чтения голосов опроса нужен user-токен. Добавьте VK_USER_TOKEN в .env и перезапустите бота.'
      );
      return;
    }

    if (error?.code === 27) {
      await context.send(
        'Не удалось прочитать голоса опроса: метод polls.getVoters недоступен для group-токена. ' +
          'Нужен VK_USER_TOKEN в .env.'
      );
      return;
    }

    console.error('Failed to create collection', {
      code: error?.code,
      message: error?.message
    });
    await context.send('Не получилось обработать опрос. Проверьте настройки токенов и попробуйте снова.');
  }
});

vk.updates.on('message_event', async (context) => {
  if (DEBUG_EVENTS) {
    console.log('message_event received', {
      peerId: context.peerId,
      userId: context.userId,
      eventId: context.eventId,
      payloadType: typeof context.eventPayload
    });
  }

  await acknowledgeEvent(context);
  try {
    const payloadRaw = context.eventPayload;
    const payload = typeof payloadRaw === 'string'
      ? JSON.parse(payloadRaw)
      : (payloadRaw || {});
    const action = payload.action;
    const collectionId = payload.collectionId;

    if (!action || !collectionId) {
      return;
    }

    const collection = state.collections[collectionId];

    if (!collection) {
      return;
    }

    // Backward compatibility: older collections might miss conversationMessageId.
    if (!collection.conversationMessageId && context.conversationMessageId) {
      collection.conversationMessageId = Number(context.conversationMessageId);
      await saveState();
    }

    const userId = Number(context.userId);

    if (action === ACTIONS.PAY_SELF) {
      const before = collection.unpaidSelf.length;
      collection.unpaidSelf = collection.unpaidSelf.filter((id) => Number(id) !== userId);

      if (collection.unpaidSelf.length === before) {
        return;
      }

      await saveState();
      await refreshCollectionMessage(collection);
      return;
    }

    if (action === ACTIONS.PAY_INVITED) {
      const current = Number(collection.invitedByUser[userId] ?? 0);
      if (current <= 0) {
        return;
      }

      const nextValue = current - 1;
      if (nextValue <= 0) {
        delete collection.invitedByUser[userId];
      } else {
        collection.invitedByUser[userId] = nextValue;
      }

      await saveState();
      await refreshCollectionMessage(collection);
    }
  } catch (error) {
    console.error('Failed to handle message_event', {
      code: error?.code,
      message: error?.message
    });
  }
});

(async () => {
  await ensureStateLoaded();
  await vk.updates.start();
  console.log('VK Poll Payment Bot started');
})();
