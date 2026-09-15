const axios = require('axios');
const crypto = require('crypto');
const dotenv = require('dotenv');
const fs = require('fs');
const opentype = require('opentype.js');
const path = require('path');
const sharp = require('sharp');
const config = require('./config.json');
const {
  DB_PATH,
  saveScheduledPost,
  importPublishedPost,
  getQueueStateExport,
  importQueueState,
  listScheduledPosts,
  getScheduledPost,
  getLatestScheduledPost,
  listPostsForReservationFix,
  listCheckedReservationPosts,
  listFutureScheduledPosts,
  listPostsForReservationFixByIds,
  markReservationsChecked,
  reopenReservationsChecked,
  markScheduledPostPublished,
  getNextRouletteSequenceNumber,
  getScheduledPostByProductFingerprint,
  getOrCreateGoldBlock,
  getGoldBlock,
  getPostItems,
  replacePostItems,
  getUsedPhotoHistory,
  markPostItemsState,
  markScheduledPostDeleted,
  resetTestPosts,
  getUsedItemsSummary,
  getReservationByCommentId,
  getReservationByCommentItem,
  saveReservation,
  updateReservationResolved,
  updateReservationUnresolvedComment,
  listReservations,
  listPendingPhotoCommentReservations,
  ensureReservationPhotoCommentGuid,
  markReservationPhotoCommentSent,
  markReservationPhotoCommentFailed,
  listBackfillablePhotoCommentReservations,
  backfillPhotoCommentPending,
  recordVkApiUsage,
  getApiUsageRows,
  getApiUsageTotal,
} = require('./db');
const {
  GOLD_BLOCK_SIZE,
  createGoldPosition,
  getGoldBlockNumber,
  resolveRouletteVariant,
} = require('./rouletteVariant');

dotenv.config({ quiet: true });

const VK_API_URL = 'https://api.vk.com/method';
const VK_API_VERSION = process.env.VK_API_VERSION || '5.199';
const GROUP_ID = Number(process.env.VK_GROUP_ID);
const SERVICE_TOKEN = process.env.VK_SERVICE_TOKEN;
const GROUP_TOKEN = process.env.VK_GROUP_TOKEN;
const USER_TOKEN = process.env.VK_USER_TOKEN;
const DRY_RUN = process.env.DRY_RUN !== 'false';
const SKIP_UNRESOLVED_REPLIES = process.env.SKIP_UNRESOLVED_REPLIES === 'true';
const PHOTO_COMMENT_BACKFILL_SINCE = process.env.PHOTO_COMMENT_BACKFILL_SINCE;
const RESERVATION_GRACE_DAYS = Number(process.env.RESERVATION_GRACE_DAYS || 3);
const PUBLISH_DELAY_MINUTES = Number(process.env.PUBLISH_DELAY_MINUTES || 130);
const ROULETTE_CARD_ATTACHMENT = process.env.VK_ROULETTE_CARD_ATTACHMENT || config.rouletteCardAttachment || '';
const ROULETTE_GOLD_CARD_ATTACHMENT = process.env.VK_ROULETTE_GOLD_CARD_ATTACHMENT || config.rouletteGoldCardAttachment || '';
const NORMAL_DISCOUNT_PERCENT = Number(config.discountPercent || 25);
const GOLD_DISCOUNT_PERCENT = Number(config.goldDiscountPercent || 35);
const VK_API_MONTHLY_BUDGET = Number(process.env.VK_API_MONTHLY_BUDGET || 0);
// Isolated VK rendering hint. Remove this constant/param if VK rejects it.
const PRIMARY_ATTACHMENTS_MODE = 'grid';
const RUNTIME_DIR = path.join(__dirname, 'runtime');
const QUEUE_STATE_EXPORT_PATH = path.join(RUNTIME_DIR, 'queue-state-export.json');
const OUTPUT_DIR = path.join(__dirname, 'output');
const PREVIEW_PATH = path.join(OUTPUT_DIR, 'preview.jpg');
const RUSSO_ONE_FONT_PATH = path.join(__dirname, 'assets', 'fonts', 'RussoOne-Regular.woff');
const RUSSO_ONE_LATIN_FONT_PATH = path.join(__dirname, 'assets', 'fonts', 'RussoOne-Latin-Regular.woff');
const PREVIEW_WIDTH = 1080;
const PREVIEW_HEIGHT = 1480;
const SAFE_PADDING = 40;
const CELL_GAP = 6;
const HEADER_HEIGHT = 0;
const CARD_WIDTH = Math.floor((PREVIEW_WIDTH - SAFE_PADDING * 2 - CELL_GAP * 2) / 3);
const CARD_HEIGHT = Math.floor((PREVIEW_HEIGHT - SAFE_PADDING * 2 - CELL_GAP * 2) / 3);
const LEGACY_SCAN_BORDER_THRESHOLD = 10;
const LEGACY_SCAN_SCALE = 0.94;
const WHITE_PIXEL_THRESHOLD = 235;
const WHITE_LINE_RATIO = 0.82;
const COMIC_BBOX_SAMPLE_SIZE = 360;
const COMIC_BBOX_BACKGROUND_DISTANCE = 38;
const COMIC_BBOX_MIN_AREA_RATIO = 0.18;
const COMIC_BBOX_CROP_PADDING_RATIO = 0.025;
const LONG_OPERATION_WARNING_MS = 30 * 1000;
const OPERATION_TIMEOUT_MS = 45 * 1000;
const VK_REQUEST_TIMEOUT_MS = 30 * 1000;
const IMAGE_REQUEST_TIMEOUT_MS = 30 * 1000;

function getReadTokenName() {
  return 'VK_SERVICE_TOKEN';
}

function getPostTokenName() {
  return 'VK_GROUP_TOKEN';
}

function parsePrice(text = '') {
  const normalized = String(text).replace(/\u00a0/g, ' ');
  const match = normalized.match(/(?:^|[^\d])(\d{1,3}(?:[\s.,]\d{3})+|\d{3,7})\s*(?:₽|руб\.?|р\.?)(?:\s|$)/i);

  if (!match) {
    return null;
  }

  return Number(match[1].replace(/[^\d]/g, ''));
}

function hasExcludedWord(text = '') {
  const lowerText = String(text).toLowerCase();
  const excludeWords = Array.isArray(config.excludeWords) ? config.excludeWords : [];

  return excludeWords.some((word) => lowerText.includes(String(word).toLowerCase()));
}

function shuffle(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withOperationTimeout(label, operation, timeoutMs = OPERATION_TIMEOUT_MS) {
  let settled = false;
  const startedAt = Date.now();
  const warningTimer = setTimeout(() => {
    if (!settled) {
      console.warn(`${label} is taking longer than ${LONG_OPERATION_WARNING_MS / 1000} seconds...`);
    }
  }, LONG_OPERATION_WARNING_MS);
  let timeoutTimer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => {
      if (!settled) {
        reject(new Error(`${label} timed out after ${timeoutMs} ms`));
      }
    }, timeoutMs);
  });

  return Promise.race([
    Promise.resolve().then(operation),
    timeoutPromise,
  ]).finally(() => {
    settled = true;
    clearTimeout(warningTimer);
    clearTimeout(timeoutTimer);
    const durationMs = Date.now() - startedAt;

    if (durationMs > LONG_OPERATION_WARNING_MS) {
      console.warn(`${label} finished after ${durationMs} ms`);
    }
  });
}

async function waitToAvoidVkRateLimit(ms = 2000) {
  console.log(`Waiting ${ms}ms to avoid VK rate limit...`);
  await sleep(ms);
}

function formatMoney(value) {
  return new Intl.NumberFormat('ru-RU').format(value);
}

function calculateDiscountPrice(price, discountPercent) {
  return Math.round(Number(price) * (100 - Number(discountPercent)) / 100);
}

function buildPostText(items, options = {}) {
  const discountPercent = Number(options.discountPercent ?? NORMAL_DISCOUNT_PERCENT);
  const variant = options.variant || 'normal';
  const priceLines = items.map((item, index) => {
    const discountedPrice = calculateDiscountPrice(item.price, discountPercent);
    const priceLine = discountPercent > 0
      ? `${formatMoney(item.price)} ₽ → ${formatMoney(discountedPrice)} ₽`
      : `${formatMoney(item.price)} ₽`;

    return `${index + 1}. ${priceLine}`;
  });

  const lines = variant === 'gold' ? [
    '✨ ЗОЛОТОЙ СЕКТОР',
    '',
    `Сегодня выпал Золотой сектор — скидка ${discountPercent}% на все ${items.length} товаров.`,
    '',
    '⏳ Актуально 24 часа — до 20:30 следующего дня.',
    'После этого пост исчезнет.',
    '',
    'Цены со скидкой:',
    '',
    ...priceLines,
    '',
    '🔔 Включайте уведомления сообщества или ставьте будильник, чтобы не пропускать новые подборки.',
    '',
    'Чтобы зафиксировать скидку, напишите в комментарии:',
    'номер лота + “бронь”',
    '',
    'Например: 6 бронь',
    '',
    'Такие выпуски появляются редко. Подпишитесь на рассылку сообщества, чтобы не пропустить следующий.',
    '',
    '#CP_СкидочнаяРулетка',
    '#CP_ЗолотойСектор',
  ] : [
    '🎲 Скидочная рулетка',
    '',
    `Каждый день в 20:30 выпадают ${items.length} случайных товаров из альбомов.`,
    `На всё из этой подборки действует скидка ${discountPercent}%.`,
    '',
    '⏳ Актуально 24 часа — до 20:30 следующего дня.',
    'После этого пост исчезнет.',
    '',
    'Цены со скидкой:',
    '',
    ...priceLines,
    '',
    '🔔 Включайте уведомления сообщества или ставьте будильник, чтобы не пропускать новые подборки.',
    '',
    'Чтобы зафиксировать скидку, напишите в комментарии:',
    'номер лота + “бронь”',
    '',
    'Например: 6 бронь',
    '',
    '#CP_СкидочнаяРулетка',
  ];

  return lines.join('\n');
}

function buildWallAttachments(items, centerAttachment = ROULETTE_CARD_ATTACHMENT) {
  const productAttachments = items.map((item) => item.attachment);
  const staticCardAttachment = String(centerAttachment || '').trim();
  const attachments = staticCardAttachment
    ? [
      ...productAttachments.slice(0, 4),
      staticCardAttachment,
      ...productAttachments.slice(4),
    ]
    : productAttachments;

  return attachments
    .filter((attachment) => typeof attachment === 'string' && attachment.trim())
    .join(',');
}

function buildProductFingerprint(items) {
  return items
    .map((item) => String(item.attachment || '').trim())
    .filter(Boolean)
    .sort()
    .join('|');
}

function resolveCardAttachment(variant) {
  return variant === 'gold' ? ROULETTE_GOLD_CARD_ATTACHMENT : ROULETTE_CARD_ATTACHMENT;
}

function createRouletteAssignment(sequenceNumber = getNextRouletteSequenceNumber(), options = {}) {
  const persist = options.persist !== false;
  const goldBlockCache = options.goldBlockCache || null;
  const blockNumber = getGoldBlockNumber(sequenceNumber, GOLD_BLOCK_SIZE);
  const existingBlock = getGoldBlock(blockNumber);
  let dryRunGoldPosition = null;

  if (!persist && goldBlockCache) {
    if (!goldBlockCache.has(blockNumber)) {
      goldBlockCache.set(blockNumber, existingBlock
        ? Number(existingBlock.gold_position)
        : createGoldPosition(Math.random, GOLD_BLOCK_SIZE));
    }

    dryRunGoldPosition = goldBlockCache.get(blockNumber);
  }

  const block = persist
    ? getOrCreateGoldBlock(blockNumber, () => createGoldPosition(Math.random, GOLD_BLOCK_SIZE))
    : {
      blockNumber,
      goldPosition: dryRunGoldPosition
        ?? (existingBlock ? Number(existingBlock.gold_position) : createGoldPosition(Math.random, GOLD_BLOCK_SIZE)),
      created: false,
    };
  const assignment = resolveRouletteVariant(sequenceNumber, block.goldPosition, {
    blockSize: GOLD_BLOCK_SIZE,
    normalDiscountPercent: NORMAL_DISCOUNT_PERCENT,
    goldDiscountPercent: GOLD_DISCOUNT_PERCENT,
    normalCardAttachment: ROULETTE_CARD_ATTACHMENT,
    goldCardAttachment: ROULETTE_GOLD_CARD_ATTACHMENT,
  });

  return {
    ...assignment,
    blockCreated: block.created,
  };
}

function formatPublishDate(timestamp) {
  return new Date(timestamp * 1000).toLocaleString('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function formatMoscowDateTime(timestamp) {
  return new Date(timestamp * 1000).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function getTimezoneDebugInfo() {
  const now = new Date();
  const offsetMinutes = now.getTimezoneOffset();
  const offsetSign = offsetMinutes <= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, '0');
  const offsetRemainder = String(absoluteOffset % 60).padStart(2, '0');

  return {
    localTime: now.toString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
    utcOffset: `UTC${offsetSign}${offsetHours}:${offsetRemainder}`,
  };
}

function logPublishDateDebug(publishTimestamp) {
  const timezone = getTimezoneDebugInfo();
  const currentTimestamp = Math.floor(Date.now() / 1000);

  console.log('Publish date debug:');
  console.log(`local time: ${timezone.localTime}`);
  console.log(`timezone: ${timezone.timezone} (${timezone.utcOffset})`);
  console.log(`Current time: ${new Date(currentTimestamp * 1000).toString()} (${currentTimestamp})`);
  console.log(`Current Moscow time: ${formatMoscowDateTime(currentTimestamp)} (${currentTimestamp})`);
  console.log(`Target publish: ${new Date(publishTimestamp * 1000).toString()} (${publishTimestamp})`);
  console.log(`Target publish Moscow: ${formatMoscowDateTime(publishTimestamp)} (${publishTimestamp})`);
  console.log(`Is target in past: ${publishTimestamp <= currentTimestamp}`);
  console.log(`publish_date timestamp: ${publishTimestamp}`);
  console.log(`publish_date_text: ${formatPublishDate(publishTimestamp)}`);
}

function parsePublishTime(value = '20:30') {
  const match = String(value).match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    throw new Error('В config.json publishTime должен быть в формате HH:mm');
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error('В config.json publishTime должен быть корректным временем HH:mm');
  }

  return { hours, minutes };
}

function getMoscowDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hours: parts.hour,
    minutes: parts.minute,
    seconds: parts.second,
  };
}

function getMoscowTimestamp({ year, month, day, hours, minutes }) {
  return Math.floor(Date.UTC(year, month - 1, day, hours - 3, minutes, 0, 0) / 1000);
}

function getFirstPublishDate(publishTime) {
  const { hours, minutes } = parsePublishTime(publishTime);
  const moscowNow = getMoscowDateParts();
  let publishTimestamp = getMoscowTimestamp({
    year: moscowNow.year,
    month: moscowNow.month,
    day: moscowNow.day,
    hours,
    minutes,
  });

  if (publishTimestamp <= Math.floor(Date.now() / 1000)) {
    publishTimestamp += 24 * 60 * 60;
  }

  return new Date(publishTimestamp * 1000);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function toUnixTimestamp(date) {
  return Math.floor(date.getTime() / 1000);
}

function formatDateForFile(date) {
  const { year, month, day } = getMoscowDateParts(date);
  const monthText = String(month).padStart(2, '0');
  const dayText = String(day).padStart(2, '0');

  return `${year}-${monthText}-${dayText}`;
}

function formatItemList(items, discountPercent = NORMAL_DISCOUNT_PERCENT) {
  return items
    .map((item, index) => {
      const discountedPrice = calculateDiscountPrice(item.price, discountPercent);
      return `${index + 1}. ${item.attachment} — ${formatMoney(item.price)} ₽ → ${formatMoney(discountedPrice)} ₽`;
    })
    .join('\n');
}

function buildDbItems(items, discountPercent = NORMAL_DISCOUNT_PERCENT) {
  return items.map((item) => ({
    photoAttachment: item.attachment,
    photoOwnerId: item.ownerId,
    photoId: item.id,
    albumId: item.albumId,
    originalPrice: item.price,
    discountPrice: calculateDiscountPrice(item.price, discountPercent),
    photoText: item.text || '',
  }));
}

function printDbSavePreview(vkPostId, publishTimestamp, publishDateText, items) {
  console.log('');
  console.log('DB SAVE PREVIEW:');
  console.log(`scheduled_posts.vk_post_id: ${vkPostId || '(wall.post not created in DRY_RUN)'}`);
  console.log(`scheduled_posts.publish_date: ${publishTimestamp}`);
  console.log(`scheduled_posts.publish_date_text: ${publishDateText}`);
  console.log(`scheduled_posts.delete_after: ${publishTimestamp + 24 * 60 * 60}`);
  console.log('scheduled_posts.status: scheduled');
  console.log(`post_items count: ${items.length}`);
}

function printScheduledPostsList() {
  const posts = listScheduledPosts();

  console.log(`DB: ${DB_PATH}`);

  if (posts.length === 0) {
    console.log('scheduled_posts is empty');
    return;
  }

  console.log('LAST SCHEDULED POSTS:');
  posts.forEach((post) => {
    console.log([
      `vk_post_id=${post.vk_post_id}`,
      `publish_date_text=${post.publish_date_text}`,
      `status=${post.status}`,
      `variant=${post.variant || ''}`,
      `discount=${post.discount_percent || ''}`,
      `sequence=${post.roulette_sequence_number || ''}`,
      `items=${post.items_count}`,
    ].join(' | '));
  });
}

function printScheduledPost(vkPostId) {
  const post = getScheduledPost(vkPostId);

  console.log(`DB: ${DB_PATH}`);

  if (!post) {
    console.log(`Post not found: ${vkPostId}`);
    return;
  }

  const items = getPostItems(vkPostId);

  console.log('POST:');
  console.log(`vk_post_id: ${post.vk_post_id}`);
  console.log(`publish_date: ${post.publish_date}`);
  console.log(`publish_date_text: ${post.publish_date_text}`);
  console.log(`delete_after: ${post.delete_after}`);
  console.log(`status: ${post.status}`);
  console.log(`created_at: ${post.created_at}`);
  console.log(`variant: ${post.variant || ''}`);
  console.log(`discount_percent: ${post.discount_percent || ''}`);
  console.log(`card_attachment: ${post.card_attachment || ''}`);
  console.log(`roulette_sequence_number: ${post.roulette_sequence_number || ''}`);
  console.log(`gold_block_number: ${post.gold_block_number || ''}`);
  console.log(`gold_position: ${post.gold_position || ''}`);
  console.log('');
  console.log('ITEMS:');
  items.forEach((item) => {
    console.log([
      `item_number=${item.item_number}`,
      `photo_attachment=${item.photo_attachment}`,
      `original_price=${item.original_price}`,
      `discount_price=${item.discount_price}`,
    ].join(' '));
  });
}

function parseMoneyFromPostText(value = '') {
  const digits = String(value).replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

function parsePostPriceLines(text = '') {
  const pricesByNumber = new Map();
  const priceLineRegex = /^\s*(\d{1,2})\.\s*([\d\s\u00a0]+)\s*₽\s*→\s*([\d\s\u00a0]+)\s*₽/gmu;
  let match = priceLineRegex.exec(text);

  while (match) {
    pricesByNumber.set(Number(match[1]), {
      originalPrice: parseMoneyFromPostText(match[2]),
      discountPrice: parseMoneyFromPostText(match[3]),
    });
    match = priceLineRegex.exec(text);
  }

  return pricesByNumber;
}

function getWallPostPhotoAttachments(post) {
  return (post.attachments || [])
    .filter((attachment) => attachment.type === 'photo' && attachment.photo)
    .map((attachment) => attachment.photo);
}

function logPostPhotoAttachments(post, photos) {
  console.log(`Photo attachments for post ${post.id}:`);

  photos.forEach((photo, index) => {
    console.log([
      `index=${index}`,
      `attachment=photo${photo.owner_id}_${photo.id}`,
      `owner_id=${photo.owner_id}`,
      `id=${photo.id}`,
    ].join(' | '));
  });
}

function buildImportedPostItems(post) {
  const pricesByNumber = parsePostPriceLines(post.text || '');
  const photos = getWallPostPhotoAttachments(post);
  logPostPhotoAttachments(post, photos);
  const staticCardAttachments = new Set([
    String(ROULETTE_CARD_ATTACHMENT || '').trim(),
    String(ROULETTE_GOLD_CARD_ATTACHMENT || '').trim(),
  ].filter(Boolean));
  const productPhotos = photos
    .filter((photo, index) => {
      const attachment = `photo${photo.owner_id}_${photo.id}`;

      if (staticCardAttachments.size > 0) {
        return !staticCardAttachments.has(attachment);
      }

      return index > 0;
    })
    .slice(0, 8);

  if (pricesByNumber.size === 0) {
    console.warn(`Warning: prices were not parsed for post ${post.id}`);
  }

  if (productPhotos.length < 8) {
    console.warn(`Expected 8 product photos, found ${productPhotos.length}`);
  }

  return productPhotos.map((photo, index) => {
    const itemNumber = index + 1;
    const price = pricesByNumber.get(itemNumber) || {};

    return {
      photoAttachment: `photo${photo.owner_id}_${photo.id}`,
      photoOwnerId: photo.owner_id,
      photoId: photo.id,
      albumId: photo.album_id || null,
      originalPrice: price.originalPrice ?? null,
      discountPrice: price.discountPrice ?? null,
      photoText: photo.text || '',
    };
  });
}

function inferImportedPostVariant(post) {
  const text = String(post.text || '');
  const isGold = text.includes('#CP_ЗолотойСектор') || text.includes('ЗОЛОТОЙ СЕКТОР');

  return {
    variant: isGold ? 'gold' : 'normal',
    discountPercent: isGold ? GOLD_DISCOUNT_PERCENT : NORMAL_DISCOUNT_PERCENT,
    cardAttachment: isGold ? ROULETTE_GOLD_CARD_ATTACHMENT : ROULETTE_CARD_ATTACHMENT,
  };
}

function isRoulettePost(post) {
  return String(post.text || '').includes('#CP_СкидочнаяРулетка');
}

async function getRecentWallPosts(limit = 3) {
  const response = await vkQueue('wall.get', {
    owner_id: -Math.abs(GROUP_ID),
    count: limit,
  });

  await sleep(1000);

  return response.items || [];
}

async function getWallPostById(postId) {
  const response = await vkQueue('wall.getById', {
    posts: `${-Math.abs(GROUP_ID)}_${postId}`,
  });

  if (Array.isArray(response)) {
    return response[0] || null;
  }

  if (Array.isArray(response.items)) {
    return response.items[0] || null;
  }

  return null;
}

async function syncRecentRoulettePosts() {
  const posts = await getRecentWallPosts(20);
  const roulettePosts = posts.filter(isRoulettePost);
  const syncedPostIds = [];

  console.log(`Recent wall posts checked: ${posts.length}`);
  console.log(`Roulette posts found: ${roulettePosts.length}`);

  if (roulettePosts.length === 0) {
    console.log('Recent roulette posts not found in last 20 wall posts');
  }

  for (const post of roulettePosts) {
    let items = buildImportedPostItems(post);
    const importedVariant = inferImportedPostVariant(post);
    const result = importPublishedPost({
      vkPostId: post.id,
      publishDate: post.date,
      publishDateText: formatPublishDate(post.date),
      items,
      variant: importedVariant.variant,
      discountPercent: importedVariant.discountPercent,
      cardAttachment: importedVariant.cardAttachment,
      productFingerprint: buildProductFingerprint(items.map((item) => ({
        attachment: item.photoAttachment,
      }))),
    });

    syncedPostIds.push(post.id);

    if (result.saved) {
      console.log(`Imported post ${post.id}: ${items.length} items`);
      markPostItemsState(post.id, 'published', post.date);
    } else if (result.reason === 'duplicate') {
      console.log(`Post ${post.id} already exists, skipped`);
      markScheduledPostPublished(post.id, post.date);
      const existingItems = getPostItems(post.id);

      if (existingItems.length < 8) {
        console.warn(`post_items less than 8 for post ${post.id}, reimporting`);
        items = buildImportedPostItems(post);
        replacePostItems(post.id, items);
        console.log(`Reimported post ${post.id}: ${items.length} items`);
      }

      markPostItemsState(post.id, 'published', post.date);
    }

    await waitToAvoidVkRateLimit(2000);
  }

  return syncedPostIds;
}

async function reimportPostItems(postId) {
  const post = await getWallPostById(postId);

  if (!post) {
    throw new Error(`VK post not found: ${postId}`);
  }

  const dbPost = getScheduledPost(postId);

  if (!dbPost) {
    throw new Error(`Post ${postId} not found in DB. Run sync-recent first.`);
  }

  const items = buildImportedPostItems(post);
  replacePostItems(postId, items);

  console.log(`Reimported post ${postId}: ${items.length} items`);
}

async function fixRecentReservations() {
  await fixReservations();
}

function parseReservationItemNumbers(text = '') {
  const normalized = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\d]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/^[1-8]$/.test(normalized)) {
    return [Number(normalized)];
  }

  const hasExplicitReservationIntent = /(?:^|\s)(?:бронь|лот|номер)(?:\s|$)/u.test(normalized);

  if (!hasExplicitReservationIntent) {
    return [];
  }

  return [...new Set((normalized.match(/\b[1-8]\b/gu) || []).map(Number))];
}

function parseReservationItemNumber(text = '') {
  const [itemNumber = null] = parseReservationItemNumbers(text);

  return itemNumber;
}

function hasReservationIntent(text = '') {
  const normalized = String(text).toLowerCase();

  return ['бронь', 'заберу', 'отложите', 'мне', 'беру'].some((keyword) => normalized.includes(keyword));
}

function looksLikeReservationComment(text = '') {
  return parseReservationItemNumbers(text).length > 0 || hasReservationIntent(text);
}

function getReservationWindow(post, graceDays = RESERVATION_GRACE_DAYS) {
  const publishDate = Number(post.publish_date || post.date || 0);
  const officialExpiry = publishDate + 24 * 60 * 60;
  const reservationCutoff = officialExpiry + Math.max(0, Number(graceDays || 0)) * 24 * 60 * 60;

  return {
    publishDate,
    officialExpiry,
    reservationCutoff,
  };
}

function isCommentWithinReservationWindow(comment, post, graceDays = RESERVATION_GRACE_DAYS) {
  return Number(comment.date || 0) <= getReservationWindow(post, graceDays).reservationCutoff;
}

function shouldMarkReservationsChecked(post, now = Math.floor(Date.now() / 1000), graceDays = RESERVATION_GRACE_DAYS) {
  return now >= getReservationWindow(post, graceDays).reservationCutoff;
}

function shouldScanReservationsPost(post, now = Math.floor(Date.now() / 1000), graceDays = RESERVATION_GRACE_DAYS) {
  return Number(post.reservations_checked_at || 0) === 0
    && now >= getReservationWindow(post, graceDays).officialExpiry;
}

function buildReservationTasksForComment(comment, itemsByNumber) {
  return parseReservationItemNumbers(comment.text)
    .map((itemNumber) => ({
      itemNumber,
      item: itemsByNumber.get(itemNumber) || null,
    }));
}

function makeReservationIdentity(vkPostId, commentId, itemNumber) {
  return `${vkPostId}:${commentId}:${itemNumber ?? 'unresolved'}`;
}

function publicPostCopyIncludesOnly24Hours(text) {
  return String(text || '').includes('Актуально 24 часа')
    && !String(text || '').includes('96')
    && !String(text || '').includes('3 дня');
}

function getGraceReopenCandidates(posts, now = Math.floor(Date.now() / 1000), graceDays = RESERVATION_GRACE_DAYS) {
  return posts.filter((post) => {
    if (!post.reservations_checked_at) {
      return false;
    }

    const { officialExpiry, reservationCutoff } = getReservationWindow(post, graceDays);

    return now >= officialExpiry && now < reservationCutoff;
  });
}

function getUserNames(comment, profilesById, groupsById) {
  if (comment.from_id > 0) {
    const profile = profilesById.get(comment.from_id) || {};
    const firstName = profile.first_name || '';
    const lastName = profile.last_name || '';
    const userName = [firstName, lastName].filter(Boolean).join(' ').trim() || `id${comment.from_id}`;
    const displayName = userName || profile.screen_name || `id${comment.from_id}`;

    return {
      userName,
      displayName,
      mentionName: firstName || profile.screen_name || userName,
      reservationName: displayName,
    };
  }

  const group = groupsById.get(Math.abs(comment.from_id)) || {};
  const groupName = group.name || `club${Math.abs(comment.from_id)}`;

  return {
    userName: groupName,
    displayName: groupName,
    mentionName: groupName,
    reservationName: groupName,
  };
}

async function getWallComments(postId) {
  const ownerId = -Math.abs(GROUP_ID);
  const count = 100;
  let offset = 0;
  const comments = [];
  const profilesById = new Map();
  const groupsById = new Map();

  await sleep(1000);

  while (true) {
    const response = await vkReservation('wall.getComments', {
      owner_id: ownerId,
      post_id: postId,
      count,
      offset,
      sort: 'asc',
      extended: 1,
    });

    (response.profiles || []).forEach((profile) => {
      profilesById.set(profile.id, profile);
    });

    (response.groups || []).forEach((group) => {
      groupsById.set(group.id, group);
    });

    comments.push(...response.items.map((comment) => ({
      ...comment,
      ...getUserNames(comment, profilesById, groupsById),
    })));

    if (comments.length >= response.count || response.items.length === 0) {
      break;
    }

    offset += response.items.length;
  }

  return comments;
}

function printReservationsList() {
  const reservations = listReservations();

  console.log(`DB: ${DB_PATH}`);

  if (reservations.length === 0) {
    console.log('reservations is empty');
    return;
  }

  console.log('RESERVATIONS:');
  reservations.forEach((reservation) => {
    console.log([
      `vk_post_id=${reservation.vk_post_id}`,
      `item_number=${reservation.item_number || ''}`,
      `user_name=${reservation.user_name || ''}`,
      `display_name=${reservation.display_name || ''}`,
      `discount_price=${reservation.discount_price || ''}`,
      `status=${reservation.status}`,
      `photo_comment_status=${reservation.photo_comment_status || ''}`,
      `photo_comment_id=${reservation.photo_comment_id || ''}`,
      `photo_comment_last_error=${reservation.photo_comment_last_error || ''}`,
      `raw_comment=${reservation.raw_comment || ''}`,
    ].join(' | '));
  });
}

function getLocalDayRange(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return {
    start: Math.floor(start.getTime() / 1000),
    end: Math.floor(end.getTime() / 1000),
  };
}

function getLocalMonthRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1);

  return {
    start: Math.floor(start.getTime() / 1000),
    end: Math.floor(end.getTime() / 1000),
    daysInMonth: new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate(),
    currentDay: date.getDate(),
  };
}

function printApiUsageSection(title, rows) {
  console.log(title);

  if (rows.length === 0) {
    console.log('(no VK API calls recorded)');
    return;
  }

  rows.forEach((row) => {
    console.log([
      `operation=${row.operation || ''}`,
      `method=${row.method || ''}`,
      `token=${row.token_type || ''}`,
      `success=${row.success ? 'true' : 'false'}`,
      `count=${row.count}`,
    ].join(' | '));
  });
}

function printApiUsage() {
  const now = new Date();
  const todayRange = getLocalDayRange(now);
  const monthRange = getLocalMonthRange(now);
  const todayRows = getApiUsageRows(todayRange.start, todayRange.end);
  const monthRows = getApiUsageRows(monthRange.start, monthRange.end);
  const monthTotal = getApiUsageTotal(monthRange.start, monthRange.end);
  const total = Number(monthTotal.total || 0);
  const service = Number(monthTotal.service || 0);
  const group = Number(monthTotal.group || 0);

  console.log('VK API usage');
  console.log('');
  printApiUsageSection('TODAY', todayRows);
  console.log('');
  printApiUsageSection('CURRENT CALENDAR MONTH', monthRows);
  console.log('');
  console.log(`TOTAL CALLS THIS MONTH: ${total}`);
  console.log(`SERVICE CALLS: ${service}`);
  console.log(`GROUP CALLS: ${group}`);

  if (VK_API_MONTHLY_BUDGET > 0) {
    const remaining = Math.max(0, VK_API_MONTHLY_BUDGET - total);
    const percent = VK_API_MONTHLY_BUDGET > 0
      ? (total / VK_API_MONTHLY_BUDGET * 100).toFixed(1)
      : '0.0';

    console.log('');
    console.log('VK API monthly usage');
    console.log(`Used: ${total}`);
    console.log(`Budget reference: ${VK_API_MONTHLY_BUDGET}`);
    console.log(`Remaining reference: ${remaining}`);
    console.log(`Usage: ${percent}%`);
  }

  if (total > 0 && monthRange.currentDay > 0) {
    const average = total / monthRange.currentDay;
    const projected = Math.round(average * monthRange.daysInMonth);

    console.log('');
    console.log(`Average calls/day: ${average.toFixed(1)}`);
    console.log(`Projected calls by month end: ${projected}`);
  }
}

function printQueueStateCounts(prefix, queueState) {
  console.log(prefix);
  console.log(`scheduled_posts: ${queueState.scheduled_posts.length}`);
  console.log(`post_items: ${queueState.post_items.length}`);
  console.log(`used_items: ${queueState.used_items.length}`);
  console.log(`gold_blocks: ${queueState.roulette_gold_blocks.length}`);
}

function printQueueStateImportSummary(summary) {
  console.log('Queue state import summary:');
  console.log(`scheduled_posts inserted: ${summary.scheduledPostsInserted}`);
  console.log(`scheduled_posts skipped: ${summary.scheduledPostsSkipped}`);
  console.log(`post_items inserted: ${summary.postItemsInserted}`);
  console.log(`post_items skipped: ${summary.postItemsSkipped}`);
  console.log(`used_items inserted: ${summary.usedItemsInserted}`);
  console.log(`used_items skipped: ${summary.usedItemsSkipped}`);
  console.log(`gold_blocks inserted: ${summary.goldBlocksInserted}`);
  console.log(`gold_blocks skipped: ${summary.goldBlocksSkipped}`);
  console.log(`Future roulette posts: ${summary.futureScheduledPosts}`);
  console.log(`Next roulette sequence: ${summary.nextRouletteSequenceNumber}`);
}

function exportQueueState(outputPath = QUEUE_STATE_EXPORT_PATH) {
  const queueState = getQueueStateExport();
  const resolvedOutputPath = path.resolve(outputPath);

  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  fs.writeFileSync(resolvedOutputPath, `${JSON.stringify(queueState, null, 2)}\n`);

  console.log(`Queue state exported: ${resolvedOutputPath}`);
  printQueueStateCounts('Exported counts:', queueState);

  return {
    outputPath: resolvedOutputPath,
    queueState,
  };
}

function importQueueStateFromFile(inputPath) {
  if (!inputPath) {
    throw new Error('Usage: node index.js import-queue-state <file>');
  }

  const resolvedInputPath = path.resolve(inputPath);
  const queueState = JSON.parse(fs.readFileSync(resolvedInputPath, 'utf8'));
  const summary = importQueueState(queueState);

  console.log(`Queue state imported: ${resolvedInputPath}`);
  printQueueStateImportSummary(summary);

  return summary;
}

async function syncPhotoComments() {
  const reservations = listPendingPhotoCommentReservations();

  console.log(`SYNC PHOTO COMMENTS ${DRY_RUN ? 'DRY-RUN' : 'REAL RUN'}`);
  console.log(`pending reservations: ${reservations.length}`);

  if (reservations.length === 0) {
    return;
  }

  for (const reservation of reservations) {
    await deliverReservationPhotoComment(reservation);
  }
}

function parseBackfillSince(value) {
  if (!value) {
    return null;
  }

  if (/^\d+$/.test(String(value))) {
    return Number(value);
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    throw new Error('PHOTO_COMMENT_BACKFILL_SINCE must be a unix timestamp or parseable date');
  }

  return Math.floor(timestamp / 1000);
}

function backfillPhotoComments() {
  const sinceTimestamp = parseBackfillSince(PHOTO_COMMENT_BACKFILL_SINCE);

  if (!sinceTimestamp) {
    console.log('PHOTO_COMMENT_BACKFILL_SINCE is absent. Historical reservations were not backfilled.');
    return;
  }

  const reservations = listBackfillablePhotoCommentReservations(sinceTimestamp);

  console.log(`PHOTO COMMENT BACKFILL ${DRY_RUN ? 'DRY-RUN' : 'REAL RUN'}`);
  console.log(`since: ${sinceTimestamp}`);
  console.log(`reservations: ${reservations.length}`);
  reservations.forEach((reservation) => {
    console.log([
      `reservation id=${reservation.id}`,
      `vk_post_id=${reservation.vk_post_id}`,
      `comment_id=${reservation.comment_id}`,
      `display_name=${reservation.display_name || reservation.user_name || ''}`,
      `item=${reservation.item_number}`,
      `photo=${reservation.photo_attachment}`,
      `price=${reservation.discount_price}`,
    ].join(' | '));
  });

  if (DRY_RUN) {
    console.log('DRY_RUN=true: no historical reservations were changed');
    return;
  }

  const result = backfillPhotoCommentPending(sinceTimestamp);
  console.log(`Backfilled reservations: ${result.updated}`);
}

function reopenGraceReservations() {
  const now = Math.floor(Date.now() / 1000);
  const checkedPosts = listCheckedReservationPosts();
  const candidates = getGraceReopenCandidates(checkedPosts, now);

  console.log(`REOPEN GRACE RESERVATIONS ${DRY_RUN ? 'DRY-RUN' : 'REAL RUN'}`);
  console.log(`RESERVATION_GRACE_DAYS: ${RESERVATION_GRACE_DAYS}`);
  console.log('');

  candidates.forEach((post) => {
    const { officialExpiry, reservationCutoff } = getReservationWindow(post);

    console.log([
      `vk_post_id=${post.vk_post_id}`,
      `publish_date=${formatPublishDate(post.publish_date)}`,
      `official_expiry=${formatPublishDate(officialExpiry)}`,
      `reservation_cutoff=${formatPublishDate(reservationCutoff)}`,
      `old_reservations_checked_at=${formatPublishDate(post.reservations_checked_at)}`,
    ].join(' | '));
  });

  console.log('');
  console.log(`eligible_to_reopen: ${candidates.length}`);

  if (DRY_RUN) {
    console.log('DRY_RUN=true: reservations_checked_at was not changed');
    return {
      eligible: candidates.length,
      updated: 0,
    };
  }

  const result = reopenReservationsChecked(candidates.map((post) => post.vk_post_id));
  console.log(`reopened: ${result.updated}`);

  return {
    eligible: candidates.length,
    updated: result.updated,
  };
}

function buildReservationRecord({ postId, comment, item, status }) {
  const now = Math.floor(Date.now() / 1000);

  return {
    vkPostId: postId,
    commentId: comment.id,
    userId: comment.from_id,
    userName: comment.userName,
    displayName: comment.displayName || comment.userName,
    reservationName: comment.reservationName,
    itemNumber: item ? item.item_number : null,
    photoAttachment: item ? item.photo_attachment : null,
    discountPrice: item ? item.discount_price : null,
    status,
    rawComment: comment.text || '',
    createdAt: now,
    fixedAt: status === 'confirmed' ? now : null,
    replySentAt: status === 'unresolved' ? null : null,
    photoCommentStatus: status === 'confirmed' ? 'pending' : null,
    photoCommentId: null,
    photoCommentSentAt: null,
    photoCommentLastError: null,
    photoCommentGuid: null,
  };
}

function printReservationAction(action, reservation, item) {
  console.log('');
  console.log(action);
  console.log(`user: ${reservation.userId}`);
  console.log(`user_name: ${reservation.userName}`);
  console.log(`display_name: ${reservation.displayName || reservation.userName || ''}`);
  console.log(`item: ${reservation.itemNumber || ''}`);
  console.log(`photo: ${reservation.photoAttachment || ''}`);
  console.log(`price: ${reservation.discountPrice || ''}`);
  console.log(`status: ${reservation.status}`);

  if (item) {
    console.log(`photo_comment: ${buildPhotoReservationCommentText({
      ...reservation,
      discountPrice: item.discount_price,
    })}`);
  }
}

function buildPhotoReservationCommentText(reservation) {
  const displayName = reservation.displayName
    || reservation.display_name
    || reservation.userName
    || reservation.user_name
    || `id${reservation.userId || reservation.user_id || ''}`.trim()
    || 'Покупатель';
  const discountPrice = reservation.discountPrice ?? reservation.discount_price;

  return `${displayName} — бронь ${discountPrice} ₽`;
}

function buildPhotoReservationCommentRequest(reservation, guid) {
  const photoOwnerId = reservation.photoOwnerId ?? reservation.photo_owner_id;
  const photoId = reservation.photoId ?? reservation.photo_id;

  if (!photoOwnerId || !photoId) {
    throw new Error('Photo comment target is missing photo owner/id');
  }

  return {
    method: 'photos.createComment',
    tokenRole: 'user',
    params: {
      owner_id: photoOwnerId,
      photo_id: photoId,
      message: buildPhotoReservationCommentText(reservation),
      from_group: Math.abs(GROUP_ID),
      guid,
    },
  };
}

async function finalizeConfirmedReservation({ reservation, item, mode }) {
  printReservationAction(mode, reservation, item);
}

async function deliverReservationPhotoComment(reservation, options = {}) {
  const dryRun = options.dryRun ?? DRY_RUN;
  const userToken = options.userToken ?? USER_TOKEN;
  const createComment = options.createComment || ((params) => vkPhotoComment('photos.createComment', params));
  const markSent = options.markSent || markReservationPhotoCommentSent;
  const markFailed = options.markFailed || markReservationPhotoCommentFailed;
  const ensureGuid = options.ensureGuid || ensureReservationPhotoCommentGuid;
  const waitAfterSend = options.waitAfterSend !== false;

  if (reservation.photo_comment_status === 'sent' || reservation.photoCommentStatus === 'sent') {
    console.log(`Photo comment already sent for reservation ${reservation.id}, skipped`);
    return {
      status: 'skipped_sent',
    };
  }

  const fallbackGuid = reservation.photo_comment_guid
    || reservation.photoCommentGuid
    || crypto.randomUUID();
  const guidRow = dryRun || !reservation.id
    ? { photo_comment_guid: fallbackGuid }
    : ensureGuid(reservation.id, fallbackGuid);
  const guid = guidRow.photo_comment_guid || fallbackGuid;
  const request = buildPhotoReservationCommentRequest(reservation, guid);

  if (dryRun) {
    console.log('PHOTO COMMENT DRY_RUN:');
    console.log(`reservation id: ${reservation.id || ''}`);
    console.log(`wall post id: ${reservation.vk_post_id || reservation.vkPostId}`);
    console.log(`wall comment id: ${reservation.comment_id || reservation.commentId}`);
    console.log(`user/display name: ${reservation.display_name || reservation.displayName || reservation.user_name || reservation.userName || ''}`);
    console.log(`item number: ${reservation.item_number || reservation.itemNumber || ''}`);
    console.log(`target photo attachment: ${reservation.photo_attachment || reservation.photoAttachment || ''}`);
    console.log(`discount price: ${reservation.discount_price ?? reservation.discountPrice}`);
    console.log(`exact photo comment text: ${request.params.message}`);
    return {
      status: 'dry_run',
      request,
    };
  }

  if (!userToken) {
    const message = 'PHOTO COMMENT PENDING: USER TOKEN REQUIRED / EXPIRED OR INVALID';
    console.warn(message);
    if (reservation.id) {
      markFailed(reservation.id, message);
    }
    return {
      status: 'failed_retryable',
      error: message,
    };
  }

  try {
    const response = await createComment(request.params);
    const commentId = typeof response === 'number'
      ? response
      : Number(response?.comment_id || response?.id || response);

    if (!commentId) {
      throw new Error('photos.createComment did not return comment_id');
    }

    if (reservation.id) {
      markSent(reservation.id, commentId);
    }

    console.log(`Photo comment sent: ${commentId}`);
    if (waitAfterSend) {
      await waitToAvoidVkRateLimit(2000);
    }

    return {
      status: 'sent',
      commentId,
    };
  } catch (error) {
    const isTokenError = error.vkCode === 5 || /token|auth|authorization|access/i.test(error.message || '');
    const message = isTokenError
      ? 'PHOTO COMMENT PENDING: USER TOKEN REQUIRED / EXPIRED OR INVALID'
      : `PHOTO COMMENT PENDING: ${error.message || error}`;

    console.warn(message);
    if (reservation.id) {
      markFailed(reservation.id, message);
    }

    return {
      status: 'failed_retryable',
      error: message,
    };
  }
}

async function fixReservations(postsOverride = null) {
  const now = Math.floor(Date.now() / 1000);
  const sourcePosts = Array.isArray(postsOverride) ? postsOverride : listPostsForReservationFix();
  const posts = sourcePosts.filter((post) => shouldScanReservationsPost(post, now));

  if (posts.length === 0) {
    console.log('No reservation checks due');
    return;
  }

  console.log(`FIX RESERVATIONS ${DRY_RUN ? 'DRY-RUN' : 'REAL RUN'}`);
  console.log(`posts: ${posts.length}`);
  console.log(`RESERVATION_GRACE_DAYS: ${RESERVATION_GRACE_DAYS}`);
  console.log('Reservation mode: repeated daily scan until grace cutoff');
  console.log('Photo comment delivery: SQLite-idempotent photos.createComment via VK_USER_TOKEN');
  console.log('No wall.createComment, no photos.getComments, no 15-minute polling');

  if (SKIP_UNRESOLVED_REPLIES) {
    console.log('SKIP_UNRESOLVED_REPLIES=true: unresolved replies disabled');
  }

  const stats = {
    roulettePosts: posts.length,
    commentsChecked: 0,
    confirmed: 0,
    unresolved: 0,
    skippedDuplicates: 0,
    lateAfterGraceSkipped: 0,
  };

  for (const post of posts) {
    const window = getReservationWindow(post);
    const items = getPostItems(post.vk_post_id);
    const itemsByNumber = new Map(items.map((item) => [Number(item.item_number), item]));
    const foundItemNumbers = new Set();
    let comments = [];
    let scanCompleted = false;

    try {
      comments = await getWallComments(post.vk_post_id);
      scanCompleted = true;
    } catch (error) {
      console.warn(`Could not read comments for post ${post.vk_post_id}: ${error.message || error}`);
      continue;
    }

    console.log('');
    console.log(`POST ${post.vk_post_id}`);
    console.log(`status: ${post.status}`);
    console.log(`publish_date_text: ${post.publish_date_text}`);
    console.log(`official_expiry: ${formatPublishDate(window.officialExpiry)}`);
    console.log(`reservation_cutoff: ${formatPublishDate(window.reservationCutoff)}`);
    console.log(`comments: ${comments.length}`);
    stats.commentsChecked += comments.length;

    for (const comment of comments) {
      if (comment.from_id === -Math.abs(GROUP_ID)) {
        continue;
      }

      if (Number(comment.date || 0) > window.reservationCutoff) {
        stats.lateAfterGraceSkipped += 1;
        continue;
      }

      const tasks = buildReservationTasksForComment(comment, itemsByNumber);
      const isReservationLike = looksLikeReservationComment(comment.text);

      if (tasks.length === 0 && !isReservationLike) {
        continue;
      }

      if (tasks.length === 0) {
        const existingUnresolved = getReservationByCommentItem(post.vk_post_id, comment.id, null)
          || getReservationByCommentId(post.vk_post_id, comment.id);

        if (existingUnresolved) {
          if (!DRY_RUN) {
            updateReservationUnresolvedComment({
              vkPostId: post.vk_post_id,
              commentId: comment.id,
              rawComment: comment.text || '',
              replySentAt: null,
            });
          }
          stats.skippedDuplicates += 1;
          continue;
        }

        const reservation = buildReservationRecord({
          postId: post.vk_post_id,
          comment,
          item: null,
          status: 'unresolved',
        });

        printReservationAction(DRY_RUN ? 'Would save unresolved reservation' : 'Unresolved reservation', reservation, null);

        if (!DRY_RUN) {
          reservation.replySentAt = null;
          saveReservation(reservation);
        }

        stats.unresolved += 1;
        continue;
      }

      for (const task of tasks) {
        const { itemNumber, item } = task;
        const existingReservation = getReservationByCommentItem(post.vk_post_id, comment.id, itemNumber);

        if (existingReservation) {
          if (existingReservation.status === 'confirmed') {
            console.log(`Reservation already confirmed for comment ${comment.id}, item ${itemNumber}, skipped`);
            stats.skippedDuplicates += 1;
            continue;
          }
        }

        if (!item) {
          const existingUnresolved = getReservationByCommentItem(post.vk_post_id, comment.id, null);

          if (!existingUnresolved) {
            const reservation = buildReservationRecord({
              postId: post.vk_post_id,
              comment,
              item: null,
              status: 'unresolved',
            });

            printReservationAction(DRY_RUN ? 'Would save unresolved reservation' : 'Unresolved reservation', reservation, null);

            if (!DRY_RUN) {
              saveReservation(reservation);
            }
          } else {
            stats.skippedDuplicates += 1;
          }

          stats.unresolved += 1;
          continue;
        }

        if (foundItemNumbers.has(itemNumber)) {
          console.warn(`Warning: duplicate reservation for item ${itemNumber}`);
        }

        foundItemNumbers.add(itemNumber);

        const unresolvedReservation = getReservationByCommentItem(post.vk_post_id, comment.id, null);
        const reservation = buildReservationRecord({
          postId: post.vk_post_id,
          comment,
          item,
          status: 'confirmed',
        });

        let savedReservation = null;
        let deliveryReservationId = null;

        if (!DRY_RUN) {
          if (existingReservation) {
            reservation.id = existingReservation.id;
            updateReservationResolved(reservation);
            deliveryReservationId = existingReservation.id;
          } else if (unresolvedReservation) {
            reservation.id = unresolvedReservation.id;
            updateReservationResolved(reservation);
            deliveryReservationId = unresolvedReservation.id;
          } else {
            savedReservation = saveReservation(reservation);
            deliveryReservationId = savedReservation?.id;
          }
        }

        await finalizeConfirmedReservation({
          reservation,
          item,
          mode: DRY_RUN ? 'Would save confirmed reservation' : 'Confirmed reservation',
        });
        await deliverReservationPhotoComment({
          ...reservation,
          id: deliveryReservationId,
          photoOwnerId: item.photo_owner_id,
          photoId: item.photo_id,
        });
        stats.confirmed += 1;
      }
    }

    console.log(`late_after_grace_skipped: ${stats.lateAfterGraceSkipped}`);

    if (scanCompleted && !DRY_RUN) {
      if (shouldMarkReservationsChecked(post, now)) {
        markReservationsChecked(post.vk_post_id);
        console.log(`reservations_checked_at set for post ${post.vk_post_id}`);
      } else {
        console.log(`reservations_checked_at left NULL for post ${post.vk_post_id}; grace window is still open`);
      }
    }

    await waitToAvoidVkRateLimit(2000);
  }

  console.log('');
  console.log('FIX RESERVATIONS SUMMARY:');
  console.log(`roulette_posts: ${stats.roulettePosts}`);
  console.log(`comments_checked: ${stats.commentsChecked}`);
  console.log(`confirmed: ${stats.confirmed}`);
  console.log(`unresolved: ${stats.unresolved}`);
  console.log(`skipped_duplicates: ${stats.skippedDuplicates}`);
  console.log(`late_after_grace_skipped: ${stats.lateAfterGraceSkipped}`);
}
function isValidPhotoAttachment(attachment) {
  return /^photo-?\d+_\d+$/.test(String(attachment || ''));
}

function getAttachmentsInfo(attachments) {
  const items = String(attachments || '')
    .split(',')
    .map((attachment) => attachment.trim())
    .filter(Boolean);

  return {
    count: items.length,
    first: items[0] || '',
  };
}

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function getPhotoUrls(photo) {
  const sizes = Array.isArray(photo.sizes) ? photo.sizes : [];
  return sizes
    .filter((size) => size.url)
    .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))
    .map((size) => size.url);
}

function getBestPhotoUrl(photo) {
  const [bestUrl = ''] = getPhotoUrls(photo);

  return bestUrl;
}

function escapeSvgText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getCenteredRussoPath(font, text, centerX, baselineY, fontSize) {
  const previewPath = font.getPath(text, 0, 0, fontSize);
  const box = previewPath.getBoundingBox();
  const x = centerX - (box.x1 + box.x2) / 2;
  const pathData = font.getPath(text, x, baselineY, fontSize).toPathData(2);

  return pathData;
}

function buildOverlaySvg() {
  const discountPercent = Number(config.discountPercent || 0);
  const russoOneFontBuffer = fs.readFileSync(RUSSO_ONE_FONT_PATH);
  const russoOneFont = opentype.parse(russoOneFontBuffer.buffer.slice(
    russoOneFontBuffer.byteOffset,
    russoOneFontBuffer.byteOffset + russoOneFontBuffer.byteLength,
  ));
  const russoOneLatinFontBuffer = fs.readFileSync(RUSSO_ONE_LATIN_FONT_PATH);
  const russoOneLatinFont = opentype.parse(russoOneLatinFontBuffer.buffer.slice(
    russoOneLatinFontBuffer.byteOffset,
    russoOneLatinFontBuffer.byteOffset + russoOneLatinFontBuffer.byteLength,
  ));
  const titleTopPath = getCenteredRussoPath(russoOneFont, 'СКИДОЧНАЯ', 540, 649, 29);
  const titleBottomPath = getCenteredRussoPath(russoOneFont, 'РУЛЕТКА', 540, 693, 30);
  const percentPath = getCenteredRussoPath(russoOneLatinFont, `-${discountPercent}%`, 540, 832, 118);

  return Buffer.from(`
    <svg width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" viewBox="0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="stickerFill" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#d97706"/>
          <stop offset="58%" stop-color="#b45309"/>
          <stop offset="100%" stop-color="#7f1d1d"/>
        </linearGradient>
        <linearGradient id="percentFill" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#fff7ed"/>
          <stop offset="100%" stop-color="#fde68a"/>
        </linearGradient>
        <filter id="stickerShadow" x="-35%" y="-35%" width="170%" height="170%">
          <feDropShadow dx="0" dy="10" stdDeviation="9" flood-color="#020617" flood-opacity="0.34"/>
        </filter>
        <filter id="softGlow" x="-35%" y="-35%" width="170%" height="170%">
          <feGaussianBlur stdDeviation="1.8" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      <g filter="url(#stickerShadow)">
        <rect x="349" y="478" width="383" height="520" rx="40" fill="#111827" fill-opacity="0.62"/>
        <rect x="364" y="494" width="352" height="488" rx="34" fill="url(#stickerFill)" fill-opacity="0.88"/>
        <rect x="382" y="510" width="316" height="456" rx="28" fill="#fff7ed" fill-opacity="0.08"/>
        <rect x="400" y="528" width="280" height="420" rx="24" fill="#111827" fill-opacity="0.16"/>
      </g>
      <g transform="translate(540 579) rotate(-8)" filter="url(#softGlow)">
        <rect x="-27" y="-27" width="54" height="54" rx="12" fill="#fff7ed" stroke="#451a03" stroke-width="3"/>
        <circle cx="-12" cy="-12" r="4.6" fill="#451a03"/>
        <circle cx="0" cy="0" r="4.6" fill="#451a03"/>
        <circle cx="12" cy="12" r="4.6" fill="#451a03"/>
        <circle cx="12" cy="-12" r="4.6" fill="#451a03"/>
        <circle cx="-12" cy="12" r="4.6" fill="#451a03"/>
      </g>
      <path d="${titleTopPath}" fill="#fff7ed" stroke="#451a03" stroke-width="1.5"/>
      <path d="${titleBottomPath}" fill="#fff7ed" stroke="#451a03" stroke-width="1.5"/>
      <path d="${percentPath}" fill="#1c1917" fill-opacity="0.34" transform="translate(0 5)"/>
      <path d="${percentPath}" fill="#fff7ed" stroke="#1c1917" stroke-width="4" filter="url(#softGlow)"/>
      <rect x="418" y="873" width="244" height="42" rx="20" fill="#1c1917" fill-opacity="0.52"/>
      <text x="540" y="901" text-anchor="middle" font-family="Russo One, Arial, sans-serif" font-size="17" fill="#fed7aa" fill-opacity="0.94">${escapeSvgText('каждый день • 20:30')}</text>
      <rect x="664" y="1370" width="320" height="50" rx="20" fill="#111827" fill-opacity="0.66"/>
      <text x="824" y="1403" text-anchor="middle" font-family="Russo One, Arial, sans-serif" font-size="22" fill="#ffffff">${escapeSvgText('⏳ актуально 24 часа')}</text>
    </svg>
  `);
}

async function vk(method, params = {}, accessToken, options = {}) {
  const operation = options.operation || 'general';
  const tokenType = options.tokenType || 'unknown';

  if (!accessToken) {
    throw new Error(options.missingTokenMessage || 'VK token is empty');
  }

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response = null;

    try {
      response = await axios.get(`${VK_API_URL}/${method}`, {
        timeout: VK_REQUEST_TIMEOUT_MS,
        params: {
          ...params,
          access_token: accessToken,
          v: VK_API_VERSION,
        },
      });
    } catch (error) {
      recordVkApiUsage({
        operation,
        method,
        tokenType,
        success: false,
        errorKind: error.code || error.message || 'network',
      });

      if (attempt < maxAttempts) {
        const delayMs = 3000 + Math.floor(Math.random() * 2001);
        console.warn(`VK request failed on ${method}: ${error.code || error.message || error}. Retry ${attempt + 1}/${maxAttempts} after ${delayMs} ms`);
        await sleep(delayMs);
        continue;
      }

      throw error;
    }

    if (response.data.error) {
      const { error_code: code, error_msg: message } = response.data.error;
      recordVkApiUsage({
        operation,
        method,
        tokenType,
        success: false,
        vkErrorCode: code,
        errorKind: message,
      });

      if (code === 6 && attempt < maxAttempts) {
        const delayMs = 3000 + Math.floor(Math.random() * 2001);
        console.warn(`VK API rate limit on ${method}, retry ${attempt + 1}/${maxAttempts} after ${delayMs} ms`);
        await sleep(delayMs);
        continue;
      }

      const error = new Error(`VK API error ${code}: ${message}`);
      error.vkCode = code;
      error.vkMethod = method;
      error.vkMessage = message;
      throw error;
    }

    recordVkApiUsage({
      operation,
      method,
      tokenType,
      success: true,
    });
    await sleep(350);
    return response.data.response;
  }

  throw new Error(`VK API request failed: ${method}`);
}

async function vkRead(method, params = {}) {
  return vk(method, params, SERVICE_TOKEN, {
    operation: 'catalogue',
    tokenType: 'service',
    missingTokenMessage: 'VK_SERVICE_TOKEN пустой',
  });
}

async function vkQueue(method, params = {}) {
  return vk(method, params, SERVICE_TOKEN, {
    operation: 'queue',
    tokenType: 'service',
    missingTokenMessage: 'VK_SERVICE_TOKEN пустой',
  });
}

async function vkReservation(method, params = {}) {
  return vk(method, params, SERVICE_TOKEN, {
    operation: 'reservation',
    tokenType: 'service',
    missingTokenMessage: 'VK_SERVICE_TOKEN пустой',
  });
}

async function vkPhotoComment(method, params = {}) {
  return vk(method, params, USER_TOKEN, {
    operation: 'reservation_photo_comment',
    tokenType: 'user',
    missingTokenMessage: 'VK_USER_TOKEN пустой',
  });
}

async function vkPosting(method, params = {}) {
  return vk(method, params, GROUP_TOKEN, {
    operation: 'posting',
    tokenType: 'group',
    missingTokenMessage: 'VK_GROUP_TOKEN пустой',
  });
}

async function publishDelayedPost(postText, attachments, publishDate) {
  if (!GROUP_TOKEN) {
    throw new Error('VK_GROUP_TOKEN пустой');
  }

  logPublishDateDebug(publishDate);

  const wallPostParams = {
    owner_id: -Math.abs(GROUP_ID),
    from_group: 1,
    message: postText,
    attachments,
    publish_date: publishDate,
    primary_attachments_mode: PRIMARY_ATTACHMENTS_MODE,
  };

  console.log('wall.post params:');
  console.log(`owner_id: ${wallPostParams.owner_id}`);
  console.log(`publish_date: ${wallPostParams.publish_date}`);
  console.log(`primary_attachments_mode: ${wallPostParams.primary_attachments_mode}`);
  console.log(`attachments: ${wallPostParams.attachments}`);
  console.log(`message: ${wallPostParams.message}`);
  console.log(`new Date(publish_date * 1000).toString(): ${new Date(wallPostParams.publish_date * 1000).toString()}`);
  console.log(`new Date(publish_date * 1000).toISOString(): ${new Date(wallPostParams.publish_date * 1000).toISOString()}`);
  console.log(`new Date(publish_date * 1000).toLocaleString(): ${new Date(wallPostParams.publish_date * 1000).toLocaleString()}`);
  console.log(`Intl.DateTimeFormat().resolvedOptions().timeZone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

  return vkPosting('wall.post', wallPostParams);
}

async function getAlbumPhotos(albumId) {
  const ownerId = -Math.abs(GROUP_ID);
  const count = 1000;
  let offset = 0;
  const photos = [];

  while (true) {
    const response = await vkRead('photos.get', {
      owner_id: ownerId,
      album_id: albumId,
      extended: 1,
      photo_sizes: 1,
      count,
      offset,
    });

    photos.push(...response.items);

    if (photos.length >= response.count || response.items.length === 0) {
      break;
    }

    offset += response.items.length;
  }

  return photos;
}

async function getCatalogueAlbumIds(configAlbumIds) {
  const configuredIds = new Set(configAlbumIds.map((albumId) => Number(albumId)));
  const response = await vkRead('photos.getAlbums', {
    owner_id: -Math.abs(GROUP_ID),
    need_system: 0,
    count: 1000,
  });
  const albumIds = (response.items || []).map((album) => Number(album.id));

  if (configuredIds.size === 0) {
    return albumIds;
  }

  return albumIds.filter((albumId) => configuredIds.has(albumId));
}

function normalizePhoto(photo, albumId) {
  const text = photo.text || '';
  const price = parsePrice(text);
  const imageUrls = getPhotoUrls(photo);
  const imageUrl = imageUrls[0] || '';

  if (!price || !imageUrl || hasExcludedWord(text)) {
    return null;
  }

  return {
    albumId,
    id: photo.id,
    ownerId: photo.owner_id,
    price,
    text,
    attachment: `photo${photo.owner_id}_${photo.id}`,
    imageUrl,
    imageUrls,
    commentsCount: typeof photo.comments?.count === 'number' ? photo.comments.count : null,
  };
}

async function getAllAvailableItems(albumIds) {
  const photosByAlbum = await Promise.all(albumIds.map(getAlbumPhotos));
  // TODO: позже добавить проверку комментариев под фото на слова "бронь"/"продано", когда будет подходящий токен VK.
  return photosByAlbum
    .flatMap((photos, index) => photos.map((photo) => normalizePhoto(photo, albumIds[index])))
    .filter(Boolean);
}

function buildScheduledPostPlans(products, options = {}) {
  const itemsPerPost = Number(options.itemsPerPost || 8);
  const scheduledPostsCount = Number(options.scheduledPostsCount || 1);
  const publishTime = options.publishTime || '20:30';
  const neededItemsCount = itemsPerPost * scheduledPostsCount;

  if (products.length < neededItemsCount) {
    throw new Error(`Недостаточно товаров для ${scheduledPostsCount} постов без повторов: нужно ${neededItemsCount}, доступно ${products.length}`);
  }

  const usedPhotoIds = new Set();
  const firstPublishDate = getFirstPublishDate(publishTime);
  const plans = [];

  for (let index = 0; index < scheduledPostsCount; index += 1) {
    const availableProducts = products.filter((item) => !usedPhotoIds.has(item.attachment));
    const selected = shuffle(availableProducts).slice(0, itemsPerPost);

    if (selected.length < itemsPerPost) {
      throw new Error(`Недостаточно товаров для поста ${index + 1}: нужно ${itemsPerPost}, доступно ${selected.length}`);
    }

    selected.forEach((item) => {
      usedPhotoIds.add(item.attachment);
    });

    const publishDate = addDays(firstPublishDate, index);

    plans.push({
      index: index + 1,
      items: selected,
      postText: buildPostText(selected),
      publishDate,
      publishTimestamp: toUnixTimestamp(publishDate),
      previewPath: path.join(OUTPUT_DIR, `preview-${index + 1}.jpg`),
    });
  }

  return plans;
}

function isScheduledTimeTakenError(error) {
  return error.vkCode === 214
    && error.vkMethod === 'wall.post'
    && String(error.vkMessage || '').includes('a post is already scheduled for this time');
}

async function publishDelayedPostSkippingTakenDates(postText, attachments, publishDate) {
  let nextPublishDate = new Date(publishDate);

  while (true) {
    try {
      const publishTimestamp = toUnixTimestamp(nextPublishDate);
      const result = await publishDelayedPost(postText, attachments, publishTimestamp);

      return {
        result,
        publishDate: nextPublishDate,
        publishTimestamp,
      };
    } catch (error) {
      if (!isScheduledTimeTakenError(error)) {
        throw error;
      }

      console.log(`Дата занята, пропускаю: ${formatDateForFile(nextPublishDate)} ${config.publishTime || '20:30'}`);
      await sleep(500);
      nextPublishDate = addDays(nextPublishDate, 1);
    }
  }
}

async function downloadImage(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: IMAGE_REQUEST_TIMEOUT_MS,
  });

  return Buffer.from(response.data);
}

async function downloadItemImage(item) {
  const urls = Array.isArray(item.imageUrls) && item.imageUrls.length > 0
    ? item.imageUrls
    : [item.imageUrl];
  let lastError = null;

  for (const url of urls) {
    try {
      return await downloadImage(url);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Не удалось скачать изображение для ${item.attachment}: ${lastError.message || lastError}`);
}

function isWhitePixel(data, offset, channels) {
  return data[offset] >= WHITE_PIXEL_THRESHOLD
    && data[offset + 1] >= WHITE_PIXEL_THRESHOLD
    && data[offset + 2] >= WHITE_PIXEL_THRESHOLD
    && (channels < 4 || data[offset + 3] >= WHITE_PIXEL_THRESHOLD);
}

function getColumnWhiteRatio(data, width, height, channels, x) {
  let whitePixels = 0;

  for (let y = 0; y < height; y += 1) {
    const offset = (y * width + x) * channels;

    if (isWhitePixel(data, offset, channels)) {
      whitePixels += 1;
    }
  }

  return whitePixels / height;
}

function getRowWhiteRatio(data, width, channels, y) {
  let whitePixels = 0;

  for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * channels;

    if (isWhitePixel(data, offset, channels)) {
      whitePixels += 1;
    }
  }

  return whitePixels / width;
}

function countWhiteBorderFromStart(length, maxScan, getRatio) {
  let thickness = 0;

  for (let index = 0; index < maxScan && index < length; index += 1) {
    if (getRatio(index) < WHITE_LINE_RATIO) {
      break;
    }

    thickness += 1;
  }

  return thickness;
}

async function getWhiteBorderThickness(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const maxHorizontalScan = Math.min(80, Math.floor(width / 3));
  const maxVerticalScan = Math.min(80, Math.floor(height / 3));

  return {
    left: countWhiteBorderFromStart(width, maxHorizontalScan, (x) => getColumnWhiteRatio(data, width, height, channels, x)),
    right: countWhiteBorderFromStart(width, maxHorizontalScan, (x) => getColumnWhiteRatio(data, width, height, channels, width - 1 - x)),
    top: countWhiteBorderFromStart(height, maxVerticalScan, (y) => getRowWhiteRatio(data, width, channels, y)),
    bottom: countWhiteBorderFromStart(height, maxVerticalScan, (y) => getRowWhiteRatio(data, width, channels, height - 1 - y)),
  };
}

function isLegacyScanBorder(border) {
  return Math.max(border.left, border.right, border.top, border.bottom) < LEGACY_SCAN_BORDER_THRESHOLD;
}

async function addLegacyScanPadding(buffer) {
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width || CARD_WIDTH;
  const height = metadata.height || CARD_HEIGHT;
  const innerWidth = Math.round(width * LEGACY_SCAN_SCALE);
  const innerHeight = Math.round(height * LEGACY_SCAN_SCALE);
  const resized = await sharp(buffer)
    .resize(innerWidth, innerHeight, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 94 })
    .toBuffer();
  const resizedMetadata = await sharp(resized).metadata();

  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite([{
      input: resized,
      left: Math.round((width - (resizedMetadata.width || innerWidth)) / 2),
      top: Math.round((height - (resizedMetadata.height || innerHeight)) / 2),
    }])
    .jpeg({ quality: 94 })
    .toBuffer();
}

function getPixelColor(data, width, channels, x, y) {
  const offset = (y * width + x) * channels;

  return [
    data[offset],
    data[offset + 1],
    data[offset + 2],
  ];
}

function averageColors(colors) {
  const result = colors.reduce((acc, color) => [
    acc[0] + color[0],
    acc[1] + color[1],
    acc[2] + color[2],
  ], [0, 0, 0]);

  return result.map((value) => value / colors.length);
}

function colorDistance(a, b) {
  const red = a[0] - b[0];
  const green = a[1] - b[1];
  const blue = a[2] - b[2];

  return Math.sqrt(red * red + green * green + blue * blue);
}

function sampleCornerBackgrounds(data, width, height, channels) {
  const insetX = Math.max(0, Math.floor(width * 0.035));
  const insetY = Math.max(0, Math.floor(height * 0.035));
  const maxX = width - 1;
  const maxY = height - 1;

  return [
    getPixelColor(data, width, channels, insetX, insetY),
    getPixelColor(data, width, channels, maxX - insetX, insetY),
    getPixelColor(data, width, channels, insetX, maxY - insetY),
    getPixelColor(data, width, channels, maxX - insetX, maxY - insetY),
    averageColors([
      getPixelColor(data, width, channels, insetX, insetY),
      getPixelColor(data, width, channels, maxX - insetX, insetY),
      getPixelColor(data, width, channels, insetX, maxY - insetY),
      getPixelColor(data, width, channels, maxX - insetX, maxY - insetY),
    ]),
  ];
}

async function detectComicBoundingBox(buffer) {
  const originalMetadata = await sharp(buffer).metadata();
  const originalWidth = originalMetadata.width || 0;
  const originalHeight = originalMetadata.height || 0;

  if (!originalWidth || !originalHeight) {
    return null;
  }

  const sampleWidth = Math.min(COMIC_BBOX_SAMPLE_SIZE, originalWidth);
  const sampleHeight = Math.round(originalHeight * (sampleWidth / originalWidth));
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize(sampleWidth, sampleHeight, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const backgrounds = sampleCornerBackgrounds(data, width, height, channels);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let foregroundPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = getPixelColor(data, width, channels, x, y);
      const nearestBackgroundDistance = Math.min(...backgrounds.map((background) => colorDistance(color, background)));

      if (nearestBackgroundDistance <= COMIC_BBOX_BACKGROUND_DISTANCE) {
        continue;
      }

      foregroundPixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  const bboxWidth = maxX - minX + 1;
  const bboxHeight = maxY - minY + 1;
  const bboxAreaRatio = (bboxWidth * bboxHeight) / (width * height);

  if (bboxAreaRatio < COMIC_BBOX_MIN_AREA_RATIO || foregroundPixels < width * height * 0.08) {
    return null;
  }

  const scaleX = originalWidth / width;
  const scaleY = originalHeight / height;
  const padding = Math.round(Math.min(originalWidth, originalHeight) * COMIC_BBOX_CROP_PADDING_RATIO);
  const left = Math.max(0, Math.floor(minX * scaleX) - padding);
  const top = Math.max(0, Math.floor(minY * scaleY) - padding);
  const right = Math.min(originalWidth, Math.ceil((maxX + 1) * scaleX) + padding);
  const bottom = Math.min(originalHeight, Math.ceil((maxY + 1) * scaleY) + padding);
  const cropWidth = right - left;
  const cropHeight = bottom - top;

  if (cropWidth >= originalWidth * 0.985 && cropHeight >= originalHeight * 0.985) {
    return null;
  }

  return {
    left,
    top,
    width: cropWidth,
    height: cropHeight,
  };
}

async function centerComicInPhoto(buffer, item) {
  try {
    const bbox = await detectComicBoundingBox(buffer);

    if (!bbox) {
      return buffer;
    }

    if (DRY_RUN) {
      console.log(`Comic bbox centered: ${item.attachment} (${bbox.left},${bbox.top},${bbox.width}x${bbox.height})`);
    }

    return sharp(buffer)
      .rotate()
      .extract(bbox)
      .jpeg({ quality: 94 })
      .toBuffer();
  } catch (error) {
    console.warn(`Comic bbox detection skipped for ${item.attachment}: ${error.message || error}`);
    return buffer;
  }
}

async function preparePreviewItemImage(buffer, item) {
  const centeredBuffer = await centerComicInPhoto(buffer, item);

  if (!config.legacyScanAutoPadding) {
    return centeredBuffer;
  }

  try {
    const border = await getWhiteBorderThickness(centeredBuffer);
    const legacyScan = isLegacyScanBorder(border);

    if (DRY_RUN) {
      console.log(`${legacyScan ? 'Legacy scan detected:' : 'Normal photo.'} ${item.attachment}`);
    }

    if (!legacyScan) {
      return centeredBuffer;
    }

    return addLegacyScanPadding(centeredBuffer);
  } catch (error) {
    console.warn(`Legacy scan detection skipped for ${item.attachment}: ${error.message || error}`);
    return centeredBuffer;
  }
}

async function createPreviewImage(items, outputPath = PREVIEW_PATH) {
  ensureOutputDir();
  fs.accessSync(RUSSO_ONE_FONT_PATH, fs.constants.R_OK);
  console.log('Russo One font loaded successfully');

  const imageBuffers = [];

  for (const [index, item] of items.entries()) {
    console.log(`Downloading preview image ${index + 1}/${items.length}: ${item.attachment}`);
    imageBuffers.push(await withOperationTimeout(
      `Downloading preview image ${item.attachment}`,
      () => downloadItemImage(item),
      IMAGE_REQUEST_TIMEOUT_MS * 2,
    ));
    console.log(`Preview image downloaded: ${item.attachment}`);
  }

  console.log('All preview images downloaded.');
  console.log('Rendering preview background...');
  const firstBackground = await sharp(imageBuffers[0])
    .resize(PREVIEW_WIDTH, PREVIEW_HEIGHT, { fit: 'cover', position: sharp.strategy.attention })
    .blur(18)
    .modulate({ brightness: 0.62, saturation: 0.68 })
    .jpeg({ quality: 88 })
    .toBuffer();
  const composites = [{ input: firstBackground, left: 0, top: 0 }];
  const gridSlots = [0, 1, 2, 3, 5, 6, 7, 8];

  for (const [index, buffer] of imageBuffers.entries()) {
    console.log(`Rendering preview cell ${index + 1}/${imageBuffers.length}`);
    const gridIndex = gridSlots[index] ?? index;
    const left = SAFE_PADDING + (gridIndex % 3) * (CARD_WIDTH + CELL_GAP);
    const top = SAFE_PADDING + Math.floor(gridIndex / 3) * (CARD_HEIGHT + CELL_GAP);
    const input = await sharp(buffer)
      .resize(CARD_WIDTH, CARD_HEIGHT, { fit: 'cover', position: sharp.strategy.attention })
      .jpeg({ quality: 90 })
      .toBuffer();

    composites.push({ input, left, top });
  }

  console.log('Rendering preview overlay...');
  composites.push({
    input: buildOverlaySvg(),
    left: 0,
    top: 0,
  });

  console.log('Writing preview file...');
  await sharp({
    create: {
      width: PREVIEW_WIDTH,
      height: PREVIEW_HEIGHT,
      channels: 3,
      background: '#111827',
    },
  })
    .composite(composites)
    .jpeg({ quality: 92 })
    .toFile(outputPath);
  console.log('Preview file written.');

  return outputPath;
}

function buildMissingQueueDates(existingQueuePosts, queueDays, publishTime) {
  const existingDateKeys = new Set(
    existingQueuePosts.map((post) => formatDateForFile(new Date(post.date * 1000))),
  );
  const dates = [];
  let cursor = getFirstPublishDate(publishTime);

  while (existingQueuePosts.length + dates.length < queueDays) {
    const key = formatDateForFile(cursor);

    if (!existingDateKeys.has(key)) {
      dates.push(new Date(cursor));
      existingDateKeys.add(key);
    }

    cursor = addDays(cursor, 1);
  }

  return dates;
}

function buildTestQueueDates(existingQueuePosts, postsCount, publishTime) {
  const existingDateKeys = new Set(
    existingQueuePosts.map((post) => formatDateForFile(new Date(post.date * 1000))),
  );
  const dates = [];
  let cursor = getFirstPublishDate(publishTime);

  while (dates.length < postsCount) {
    const key = formatDateForFile(cursor);

    if (!existingDateKeys.has(key)) {
      dates.push(new Date(cursor));
      existingDateKeys.add(key);
    }

    cursor = addDays(cursor, 1);
  }

  return dates;
}

async function getQueueCandidateItems(albumIds) {
  const products = [];
  let loadedPhotos = 0;
  const catalogueAlbumIds = await getCatalogueAlbumIds(albumIds);
  let photosWithCommentCounters = 0;

  for (const albumId of catalogueAlbumIds) {
    const photos = await getAlbumPhotos(albumId);
    loadedPhotos += photos.length;
    photos.forEach((photo) => {
      const item = normalizePhoto(photo, albumId);

      if (item) {
        if (typeof item.commentsCount === 'number') {
          photosWithCommentCounters += 1;
        }

        products.push(item);
      }
    });
  }

  console.log(`Loaded photos: ${loadedPhotos}`);
  console.log(`Photos with catalogue comment counters: ${photosWithCommentCounters}`);
  if (photosWithCommentCounters === 0) {
    console.log('Product comment exclusion via photos.getComments is disabled for service-token migration.');
  }
  return products;
}

async function photoHasAnyComments(item) {
  if (typeof item.commentsCount === 'number') {
    return item.commentsCount > 0;
  }

  return false;
}

function splitQueueCandidates(candidates, usedPhotoHistory, futureScheduledAttachments, reuseAfterDays) {
  const unusedCandidates = [];
  const reusableCandidates = [];
  const cooldownSeconds = Math.max(0, Number(reuseAfterDays || 0)) * 24 * 60 * 60;
  const cooldownCutoff = Math.floor(Date.now() / 1000) - cooldownSeconds;

  for (const item of candidates) {
    if (futureScheduledAttachments.has(item.attachment)) {
      continue;
    }

    const usedState = usedPhotoHistory.get(item.attachment);

    if (!usedState) {
      unusedCandidates.push(item);
      continue;
    }

    const usedAt = Number(usedState.usedAt || 0);

    if (usedAt <= cooldownCutoff) {
      reusableCandidates.push({
        item,
        usedAt,
      });
    }
  }

  reusableCandidates.sort((a, b) => a.usedAt - b.usedAt);

  return {
    unusedCandidates: shuffle(unusedCandidates),
    reusableCandidates: reusableCandidates.map((candidate) => candidate.item),
  };
}

async function selectFromCandidateWindows(candidates, itemsPerPost, candidatePoolSize) {
  const selected = [];
  let commentChecks = 0;

  for (let start = 0; start < candidates.length && selected.length < itemsPerPost; start += candidatePoolSize) {
    const window = candidates.slice(start, start + candidatePoolSize);
    console.log(`Candidate window: ${start + 1}-${start + window.length}`);

    for (const item of window) {
      if (selected.length >= itemsPerPost) {
        break;
      }

      try {
        commentChecks += 1;

        if (!(await photoHasAnyComments(item))) {
          selected.push(item);
        }
      } catch (error) {
        console.warn(`Skipping ${item.attachment}: ${error.message || error}`);
      }
    }

    console.log(`Comment checks: ${commentChecks}`);
    console.log(`Selected: ${selected.length}`);
  }

  return selected;
}

async function selectQueueItems(
  candidates,
  usedPhotoHistory,
  futureScheduledAttachments,
  itemsPerPost,
  candidatePoolSize,
  reuseAfterDays,
) {
  const { unusedCandidates, reusableCandidates } = splitQueueCandidates(
    candidates,
    usedPhotoHistory,
    futureScheduledAttachments,
    reuseAfterDays,
  );

  console.log(`Cheap filter: ${unusedCandidates.length}`);

  console.log('Checking catalogue comment counters...');
  const selected = await selectFromCandidateWindows(unusedCandidates, itemsPerPost, candidatePoolSize);
  console.log('Catalogue comment counters checked.');

  if (selected.length >= itemsPerPost) {
    return selected;
  }

  if (reusableCandidates.length === 0) {
    return selected;
  }

  console.log(`Cooldown reusable candidates: ${reusableCandidates.length}`);
  console.log('Checking catalogue comment counters...');
  const reusableSelected = await selectFromCandidateWindows(
    reusableCandidates,
    itemsPerPost - selected.length,
    candidatePoolSize,
  );
  console.log('Catalogue comment counters checked.');

  return [...selected, ...reusableSelected];
}

async function selectUniqueQueueItems(
  candidates,
  usedPhotoHistory,
  futureScheduledAttachments,
  itemsPerPost,
  candidatePoolSize,
  reuseAfterDays,
) {
  const duplicateContentExclusions = new Set();
  const maxAttempts = 10;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const selectionExclusions = new Set([
      ...futureScheduledAttachments,
      ...duplicateContentExclusions,
    ]);
    const items = await selectQueueItems(
      candidates,
      usedPhotoHistory,
      selectionExclusions,
      itemsPerPost,
      candidatePoolSize,
      reuseAfterDays,
    );

    if (items.length < itemsPerPost) {
      return {
        items,
        fingerprint: buildProductFingerprint(items),
        duplicate: null,
      };
    }

    const fingerprint = buildProductFingerprint(items);
    const duplicate = getScheduledPostByProductFingerprint(fingerprint);

    console.log(`Product fingerprint: ${fingerprint}`);

    if (!duplicate) {
      return {
        items,
        fingerprint,
        duplicate: null,
      };
    }

    console.warn([
      'Duplicate roulette product set found:',
      `vk_post_id=${duplicate.vk_post_id}`,
      `status=${duplicate.status}`,
      `publish_date=${duplicate.publish_date_text || duplicate.publish_date}`,
    ].join(' '));

    items.forEach((item) => {
      duplicateContentExclusions.add(item.attachment);
    });
  }

  throw new Error('Could not select a unique roulette product set');
}

function getFutureScheduledProductAttachments(posts) {
  const attachments = new Set();
  const staticCardAttachments = new Set([
    String(ROULETTE_CARD_ATTACHMENT || '').trim(),
    String(ROULETTE_GOLD_CARD_ATTACHMENT || '').trim(),
  ].filter(Boolean));

  posts.forEach((post) => {
    if (!Array.isArray(post.attachments)) {
      getPostItems(post.vk_post_id || post.id).forEach((item) => {
        if (item.photo_attachment && !staticCardAttachments.has(item.photo_attachment)) {
          attachments.add(item.photo_attachment);
        }
      });
      return;
    }

    getWallPostPhotoAttachments(post).forEach((photo) => {
      const attachment = `photo${photo.owner_id}_${photo.id}`;

      if (!staticCardAttachments.has(attachment)) {
        attachments.add(attachment);
      }
    });
  });

  return attachments;
}

async function createScheduledPost(targetDate, context) {
  const {
    candidates,
    usedPhotoHistory,
    futureScheduledAttachments,
    itemsPerPost,
    candidatePoolSize,
    reuseAfterDays,
    sequenceNumber,
    goldBlockCache,
  } = context;

  console.log('');
  console.log('-------------------------');
  console.log('Creating scheduled post:');
  console.log(`Target date: ${formatPublishDate(toUnixTimestamp(targetDate))}`);
  console.log('READ TOKEN: SERVICE');
  console.log('WRITE TOKEN: GROUP');

  try {
    const assignment = createRouletteAssignment(sequenceNumber, {
      persist: !DRY_RUN,
      goldBlockCache,
    });
    const rouletteCardAttachment = String(assignment.cardAttachment || '').trim();

    if (!isValidPhotoAttachment(rouletteCardAttachment)) {
      const tokenName = assignment.variant === 'gold'
        ? 'VK_ROULETTE_GOLD_CARD_ATTACHMENT'
        : 'VK_ROULETTE_CARD_ATTACHMENT';
      throw new Error(`${tokenName} пустой или имеет неверный формат`);
    }

    console.log(`Roulette sequence: ${assignment.sequenceNumber}`);
    console.log(`Block: ${assignment.blockNumber}`);
    console.log(`Variant: ${assignment.variant.toUpperCase()}`);
    if (assignment.variant === 'gold') {
      console.log('*** GOLDEN SECTOR ***');
    }
    console.log(`Discount: ${assignment.discountPercent}`);
    console.log(`Card attachment: ${rouletteCardAttachment}`);

    console.log('Selecting candidates...');
    const selection = await withOperationTimeout(
      'Selecting candidates',
      () => selectUniqueQueueItems(
        candidates,
        usedPhotoHistory,
        futureScheduledAttachments,
        itemsPerPost,
        candidatePoolSize,
        reuseAfterDays,
      ),
      OPERATION_TIMEOUT_MS,
    );
    const { items, fingerprint: productFingerprint } = selection;
    console.log('Candidates selected.');

    if (items.length < itemsPerPost) {
      throw new Error('Not enough available products');
    }
    console.log(`Unique product fingerprint: ${productFingerprint}`);

    const postText = buildPostText(items, assignment);
    const attachments = buildWallAttachments(items, rouletteCardAttachment);

    if (!attachments) {
      throw new Error('Attachments are undefined');
    }

    const attachmentsInfo = getAttachmentsInfo(attachments);

    if (attachmentsInfo.count !== items.length + 1 || !attachmentsInfo.first) {
      throw new Error('Attachments validation failed');
    }

    console.log('Selected 8 product attachments:');
    items.forEach((item, index) => {
      console.log(`${index + 1}. ${item.attachment}`);
    });
    console.log(`Static roulette card: ${rouletteCardAttachment}`);
    console.log('Final 9 attachments in exact order:');
    String(attachments).split(',').forEach((attachment, index) => {
      console.log(`${index + 1}. ${attachment}`);
    });
    console.log(`Attachments count: ${attachmentsInfo.count}`);
    console.log(`First attachment: ${attachmentsInfo.first}`);
    console.log(`Primary attachments mode: ${PRIMARY_ATTACHMENTS_MODE}`);

    if (DRY_RUN) {
      const publishTimestamp = toUnixTimestamp(targetDate);
      logPublishDateDebug(publishTimestamp);
      console.log(`DRY_RUN=true: wall.post skipped`);
      printDbSavePreview(null, publishTimestamp, formatPublishDate(publishTimestamp), buildDbItems(items, assignment.discountPercent));
      console.log(`scheduled_posts.product_fingerprint: ${productFingerprint}`);
      console.log('-------------------------');
      return {
        ok: true,
        dryRun: true,
        saved: false,
        items,
        usedAt: publishTimestamp,
        publishTimestamp,
        assignment,
      };
    }
    console.log('Creating wall.post...');

    const publishResult = await withOperationTimeout(
      'Creating wall.post',
      () => publishDelayedPostSkippingTakenDates(postText, attachments, targetDate),
      OPERATION_TIMEOUT_MS,
    );
    console.log('Done.');
    const vkPostId = publishResult.result.post_id;

    if (!vkPostId) {
      throw new Error('wall.post did not return post_id');
    }

    console.log(`Post id: ${vkPostId}`);
    console.log('Created scheduled post:');
    console.log(`vk_post_id: ${vkPostId}`);
    console.log(`publish_date: ${formatPublishDate(publishResult.publishTimestamp)}`);

    const dbResult = saveScheduledPost({
      vkPostId,
      publishDate: publishResult.publishTimestamp,
      publishDateText: formatPublishDate(publishResult.publishTimestamp),
      items: buildDbItems(items, assignment.discountPercent),
      variant: assignment.variant,
      discountPercent: assignment.discountPercent,
      cardAttachment: rouletteCardAttachment,
      rouletteSequenceNumber: assignment.sequenceNumber,
      goldBlockNumber: assignment.blockNumber,
      goldPosition: assignment.goldPosition,
      productFingerprint,
    });

    if (!dbResult.saved) {
      console.log(`Queued post DB save skipped: ${vkPostId}`);
    } else {
      console.log('DB saved.');
    }

    await waitToAvoidVkRateLimit(2000);
    console.log('-------------------------');

    return {
      ok: true,
      vkPostId,
      saved: dbResult.saved,
      items,
      usedAt: publishResult.publishTimestamp,
      publishTimestamp: publishResult.publishTimestamp,
      assignment,
    };
  } catch (error) {
    console.error(`Scheduled post failed: ${error.message || error}`);
    console.log('-------------------------');
    return {
      ok: false,
      error,
    };
  }
}

async function ensureQueue() {
  const queueDays = Number(config.queueDays || 3);
  const testQueuePosts = Number(config.testQueuePosts || 0);
  const publishTime = config.publishTime || '20:30';
  const itemsPerPost = Number(config.itemsPerPost || 8);
  const candidatePoolSize = Number(config.candidatePoolSize || 30);
  const reuseAfterDays = Number(config.reuseAfterDays || 120);
  const albumIds = Array.isArray(config.albums) ? config.albums : [];

  if (albumIds.length === 0) {
    throw new Error('В config.json не указаны albums');
  }

  console.log('Queue source of truth: SQLite scheduled_posts');
  console.log('VK postponed reconciliation is disabled for normal ensure-queue maintenance.');
  console.log('Loading local future scheduled posts...');
  const nowTimestamp = Math.floor(Date.now() / 1000);
  const rouletteQueuePosts = listFutureScheduledPosts(nowTimestamp)
    .map((post) => ({
      ...post,
      id: post.vk_post_id,
      date: post.publish_date,
      text: '#CP_СкидочнаяРулетка',
    }));
  console.log('Local future scheduled posts loaded.');

  console.log(`Future roulette posts: ${rouletteQueuePosts.length}`);
  console.log(`queueDays: ${queueDays}`);
  console.log(`testQueuePosts: ${testQueuePosts}`);

  const missingDates = testQueuePosts > 0
    ? buildTestQueueDates(rouletteQueuePosts, testQueuePosts, publishTime)
    : buildMissingQueueDates(rouletteQueuePosts, queueDays, publishTime);
  const currentTimestamp = Math.floor(Date.now() / 1000);

  console.log('');
  console.log(`Current Moscow time: ${formatMoscowDateTime(currentTimestamp)}`);
  console.log(`First queue date: ${missingDates[0] ? formatMoscowDateTime(toUnixTimestamp(missingDates[0])) : '(none)'}`);
  console.log('Current future posts:');
  if (rouletteQueuePosts.length === 0) {
    console.log('(none)');
  } else {
    rouletteQueuePosts.forEach((post) => {
      console.log(`${post.id} | ${formatPublishDate(post.date)}`);
    });
  }
  console.log(`queueDays: ${queueDays}`);
  console.log(`Need to create: ${missingDates.length}`);
  console.log(`Primary attachments mode: ${PRIMARY_ATTACHMENTS_MODE}`);
  console.log('Target dates:');
  if (missingDates.length === 0) {
    console.log('(none)');
  } else {
    missingDates.forEach((date) => {
      const targetTimestamp = toUnixTimestamp(date);
      console.log(formatMoscowDateTime(targetTimestamp));
      console.log(`Target publish: ${formatMoscowDateTime(targetTimestamp)} (${targetTimestamp})`);
      console.log(`Is target in past: ${targetTimestamp <= currentTimestamp}`);
    });
  }

  if (testQueuePosts <= 0 && rouletteQueuePosts.length >= queueDays) {
    console.log('Queue is healthy. Nothing to create.');
    console.log('');
    console.log('Queue summary:');
    console.log('Created: 0');
    console.log('Skipped: 0');
    console.log('Failed: 0');
    return;
  }

  console.log('Loading photos...');
  const candidates = await withOperationTimeout(
    'Loading photos',
    () => getQueueCandidateItems(albumIds),
    OPERATION_TIMEOUT_MS * Math.max(1, albumIds.length),
  );
  console.log('Photos loaded.');
  const futureScheduledAttachments = getFutureScheduledProductAttachments(rouletteQueuePosts);
  const usedPhotoHistory = new Map(
    getUsedPhotoHistory().map((row) => [
      row.photo_attachment,
      {
        usedAt: Number(row.used_at || 0),
        state: row.state || 'scheduled',
      },
    ]),
  );

  console.log(`Need to create: ${missingDates.length}`);
  console.log(`Candidate products: ${candidates.length}`);
  console.log(`Already used products: ${usedPhotoHistory.size}`);
  console.log(`Future scheduled product attachments: ${futureScheduledAttachments.size}`);
  console.log(`candidatePoolSize: ${candidatePoolSize}`);
  console.log(`reuseAfterDays: ${reuseAfterDays}`);

  const summary = {
    created: 0,
    skipped: 0,
    failed: 0,
  };
  let nextSequenceNumber = getNextRouletteSequenceNumber();
  const goldBlockCache = new Map();

  for (const publishDate of missingDates) {
    let targetDate = new Date(publishDate);

    while (toUnixTimestamp(targetDate) <= Math.floor(Date.now() / 1000)) {
      console.log('Target time already passed, moving to next day');
      targetDate = addDays(targetDate, 1);
    }

    const createdPost = await createScheduledPost(targetDate, {
      candidates,
      usedPhotoHistory,
      futureScheduledAttachments,
      itemsPerPost,
      candidatePoolSize,
      reuseAfterDays,
      sequenceNumber: nextSequenceNumber,
      goldBlockCache,
    });

    if (!createdPost.ok) {
      summary.failed += 1;
      continue;
    }

    nextSequenceNumber += 1;

    if (createdPost.saved) {
      summary.created += 1;
      createdPost.items.forEach((item) => {
        usedPhotoHistory.set(item.attachment, {
          usedAt: createdPost.usedAt,
          state: 'scheduled',
        });
        futureScheduledAttachments.add(item.attachment);
      });
    } else {
      summary.skipped += 1;
    }
  }

  console.log('');
  console.log('Queue summary:');
  console.log(`Created: ${summary.created}`);
  console.log(`Skipped: ${summary.skipped}`);
  console.log(`Failed: ${summary.failed}`);
}

async function printQueueState() {
  const albumIds = Array.isArray(config.albums) ? config.albums : [];
  const reuseAfterDays = Number(config.reuseAfterDays || 120);
  const cooldownSeconds = Math.max(0, reuseAfterDays) * 24 * 60 * 60;
  const cooldownCutoff = Math.floor(Date.now() / 1000) - cooldownSeconds;

  if (albumIds.length === 0) {
    throw new Error('В config.json не указаны albums');
  }

  const summary = getUsedItemsSummary();
  const usedPhotoHistory = new Map(
    getUsedPhotoHistory().map((row) => [
      row.photo_attachment,
      {
        usedAt: Number(row.used_at || 0),
        state: row.state || 'scheduled',
      },
    ]),
  );
  const candidates = await getQueueCandidateItems(albumIds);
  const availableCount = candidates.filter((item) => {
    const usedState = usedPhotoHistory.get(item.attachment);
    return !usedState || usedState.usedAt <= cooldownCutoff;
  }).length;

  console.log(`Scheduled items: ${summary.scheduled || 0}`);
  console.log(`Published items: ${summary.published || 0}`);
  console.log(`Deleted items: ${summary.deleted || 0}`);
  console.log(`Reuse after days: ${reuseAfterDays}`);
  console.log(`Available items: ${availableCount}`);
}

async function main() {
  const [command, commandArg] = process.argv.slice(2);

  if (command === 'list') {
    printScheduledPostsList();
    return;
  }

  if (command === 'show') {
    const vkPostId = Number(commandArg);

    if (!vkPostId) {
      throw new Error('Usage: node index.js show POST_ID');
    }

    printScheduledPost(vkPostId);
    return;
  }

  if (command === 'mark-deleted') {
    const vkPostId = Number(commandArg);

    if (!vkPostId) {
      throw new Error('Usage: node index.js mark-deleted POST_ID');
    }

    const result = markScheduledPostDeleted(vkPostId);

    if (!result.updated) {
      throw new Error(`Post ${vkPostId} not found.`);
    }

    console.log(`Post ${vkPostId} marked as deleted.`);
    return;
  }

  if (command === 'reset-test-posts') {
    const result = resetTestPosts();

    console.log(`Deleted test posts from DB: ${result.deletedPosts.length}`);
    result.deletedPosts.forEach((vkPostId) => {
      console.log(vkPostId);
    });
    return;
  }

  if (command === 'reservations') {
    printReservationsList();
    return;
  }

  if (command === 'api-usage') {
    printApiUsage();
    return;
  }

  if (command === 'export-queue-state') {
    exportQueueState(commandArg || QUEUE_STATE_EXPORT_PATH);
    return;
  }

  if (command === 'import-queue-state') {
    importQueueStateFromFile(commandArg);
    return;
  }

  if (command === 'sync-photo-comments') {
    await syncPhotoComments();
    return;
  }

  if (command === 'photo-comment-backfill') {
    backfillPhotoComments();
    return;
  }

  if (command === 'reopen-grace-reservations') {
    reopenGraceReservations();
    return;
  }

  if (command === 'reimport-post') {
    const vkPostId = Number(commandArg);

    if (!vkPostId) {
      throw new Error('Usage: node index.js reimport-post POST_ID');
    }

    await reimportPostItems(vkPostId);
    return;
  }

  if (!GROUP_ID) {
    throw new Error('Не задан VK_GROUP_ID в .env');
  }

  if (command === 'fix') {
    await fixReservations();
    return;
  }

  if (command === 'sync-recent') {
    await syncRecentRoulettePosts();
    return;
  }

  if (command === 'fix-recent') {
    await fixRecentReservations();
    return;
  }

  if (command === 'ensure-queue') {
    await ensureQueue();
    return;
  }

  if (command === 'queue') {
    await printQueueState();
    return;
  }

  console.log('TOKEN USAGE:');
  console.log(`photos.get: ${getReadTokenName()}`);
  console.log(`wall.post: ${getPostTokenName()}`);
  console.log('');

  const albumIds = Array.isArray(config.albums) ? config.albums : [];
  const itemsPerPost = Number(config.itemsPerPost || 8);
  const scheduledPostsCount = Number(config.scheduledPostsCount || 1);
  const publishTime = config.publishTime || '20:30';

  if (albumIds.length === 0) {
    throw new Error('В config.json не указаны albums');
  }

  const products = await getAllAvailableItems(albumIds);
  const plans = buildScheduledPostPlans(products, {
    itemsPerPost,
    scheduledPostsCount,
    publishTime,
  });

  console.log(`Scheduled posts plan: ${plans.length}`);
  let nextPublishDate = plans[0] ? new Date(plans[0].publishDate) : null;

  for (const plan of plans) {
    const rouletteCardAttachment = String(ROULETTE_CARD_ATTACHMENT || '').trim();
    let publishResult = null;
    let actualPublishTimestamp = plan.publishTimestamp;

    if (!isValidPhotoAttachment(rouletteCardAttachment)) {
      throw new Error('VK_ROULETTE_CARD_ATTACHMENT пустой или имеет неверный формат');
    }

    if (!DRY_RUN) {
      const attachmentsForPost = buildWallAttachments(plan.items, rouletteCardAttachment);
      const attachmentsInfo = getAttachmentsInfo(attachmentsForPost);

      console.log('ATTACHMENTS BEFORE WALL.POST:');
      console.log(`count: ${attachmentsInfo.count}`);
      console.log(`first: ${attachmentsInfo.first}`);

      publishResult = await publishDelayedPostSkippingTakenDates(plan.postText, attachmentsForPost, nextPublishDate);
      nextPublishDate = addDays(publishResult.publishDate, 1);
      actualPublishTimestamp = publishResult.publishTimestamp;
    }

    const attachments = buildWallAttachments(plan.items, rouletteCardAttachment);

    console.log('');
    console.log(`POST #${plan.index}`);
    console.log('PUBLISH_DATE:');
    console.log(`${actualPublishTimestamp} (${formatPublishDate(actualPublishTimestamp)})`);
    console.log('');
    console.log('SELECTED ITEMS:');
    console.log(formatItemList(plan.items));
    console.log('');
    console.log('STATIC ROULETTE CARD:');
    console.log(rouletteCardAttachment);
    console.log('');
    console.log('ATTACHMENTS:');
    console.log(attachments);

    if (DRY_RUN) {
      printDbSavePreview(null, actualPublishTimestamp, formatPublishDate(actualPublishTimestamp), buildDbItems(plan.items));
      console.log('');
      console.log('DRY_RUN=true: static card was not uploaded and wall.post was not created');
      continue;
    }

    if (!publishResult) {
      console.log('');
      console.log('Post skipped because wall.post failed');
      continue;
    }

    console.log('');
    console.log('Создан отложенный пост');
    console.log('post_id:', publishResult.result.post_id);

    if (!publishResult.result.post_id) {
      console.log('DB save skipped: wall.post did not return post_id');
      continue;
    }

    const dbResult = saveScheduledPost({
      vkPostId: publishResult.result.post_id,
      publishDate: actualPublishTimestamp,
      publishDateText: formatPublishDate(actualPublishTimestamp),
      items: buildDbItems(plan.items),
      productFingerprint: buildProductFingerprint(plan.items),
    });

    if (dbResult.saved) {
      console.log('Saved to DB:', DB_PATH);
    } else if (dbResult.reason === 'duplicate') {
      console.log('DB duplicate skipped for post_id:', publishResult.result.post_id);
    }

    await sleep(2000);
  }
}

if (require.main === module) {
  main().catch((error) => {
    if (error.vkCode === 15 && error.vkMethod) {
      console.error(`VK error 15 method: ${error.vkMethod}`);
    }

    console.error(error.message || error.code || error);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  vk,
  parsePrice,
  calculateDiscountPrice,
  buildPostText,
  buildWallAttachments,
  buildProductFingerprint,
  buildDbItems,
  buildReservationRecord,
  buildPhotoReservationCommentText,
  buildPhotoReservationCommentRequest,
  deliverReservationPhotoComment,
  createPreviewImage,
  buildScheduledPostPlans,
  getAllAvailableItems,
  publishDelayedPost,
  parseReservationItemNumbers,
  parseReservationItemNumber,
  getReservationWindow,
  isCommentWithinReservationWindow,
  shouldMarkReservationsChecked,
  shouldScanReservationsPost,
  getGraceReopenCandidates,
  buildReservationTasksForComment,
  makeReservationIdentity,
  publicPostCopyIncludesOnly24Hours,
  fixReservations,
  syncRecentRoulettePosts,
  fixRecentReservations,
  reimportPostItems,
  createScheduledPost,
  ensureQueue,
  printQueueState,
};
