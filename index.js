const axios = require('axios');
const dotenv = require('dotenv');
const FormData = require('form-data');
const fs = require('fs');
const opentype = require('opentype.js');
const path = require('path');
const sharp = require('sharp');
const config = require('./config.json');
const {
  DB_PATH,
  saveScheduledPost,
  importPublishedPost,
  listScheduledPosts,
  getScheduledPost,
  getLatestScheduledPost,
  listPostsForReservationFix,
  listPostsForReservationFixByIds,
  getPostItems,
  replacePostItems,
  getReservationByCommentId,
  saveReservation,
  updateReservationResolved,
  updateReservationUnresolvedComment,
  listReservations,
} = require('./db');

dotenv.config({ quiet: true });

const VK_API_URL = 'https://api.vk.com/method';
const VK_API_VERSION = process.env.VK_API_VERSION || '5.199';
const GROUP_ID = Number(process.env.VK_GROUP_ID);
const ACCESS_TOKEN = process.env.VK_USER_TOKEN;
const POST_TOKEN = process.env.VK_USER_TOKEN;
const DRY_RUN = process.env.DRY_RUN !== 'false';
const SKIP_UNRESOLVED_REPLIES = process.env.SKIP_UNRESOLVED_REPLIES === 'true';
const PUBLISH_DELAY_MINUTES = Number(process.env.PUBLISH_DELAY_MINUTES || 130);
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

function getReadTokenName() {
  return 'VK_USER_TOKEN';
}

function getPostTokenName() {
  return 'VK_USER_TOKEN';
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

async function waitToAvoidVkRateLimit(ms = 2000) {
  console.log(`Waiting ${ms}ms to avoid VK rate limit...`);
  await sleep(ms);
}

function formatMoney(value) {
  return new Intl.NumberFormat('ru-RU').format(value);
}

function buildPostText(items) {
  const discountPercent = Number(config.discountPercent || 0);
  const priceLines = items.map((item, index) => {
    const discountedPrice = Math.round(item.price * (100 - discountPercent) / 100);
    const priceLine = discountPercent > 0
      ? `${formatMoney(item.price)} ₽ → ${formatMoney(discountedPrice)} ₽`
      : `${formatMoney(item.price)} ₽`;

    return `${index + 1}. ${priceLine}`;
  });

  const lines = [
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

function buildWallAttachments(items, previewAttachment = '') {
  const productAttachments = items.map((item) => item.attachment);
  const attachments = previewAttachment
    ? [previewAttachment, ...productAttachments]
    : productAttachments;

  return attachments
    .filter((attachment) => typeof attachment === 'string' && attachment.trim())
    .join(',');
}

function formatPublishDate(timestamp) {
  return new Date(timestamp * 1000).toLocaleString('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
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

function getFirstPublishDate(publishTime) {
  const { hours, minutes } = parsePublishTime(publishTime);
  const publishDate = new Date();

  publishDate.setHours(hours, minutes, 0, 0);

  if (publishDate.getTime() <= Date.now()) {
    publishDate.setDate(publishDate.getDate() + 1);
  }

  return publishDate;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function toUnixTimestamp(date) {
  return Math.floor(date.getTime() / 1000);
}

function formatDateForFile(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function formatItemList(items) {
  const discountPercent = Number(config.discountPercent || 0);

  return items
    .map((item, index) => {
      const discountedPrice = Math.round(item.price * (100 - discountPercent) / 100);
      return `${index + 1}. ${item.attachment} — ${formatMoney(item.price)} ₽ → ${formatMoney(discountedPrice)} ₽`;
    })
    .join('\n');
}

function buildDbItems(items) {
  const discountPercent = Number(config.discountPercent || 0);

  return items.map((item) => ({
    photoAttachment: item.attachment,
    photoOwnerId: item.ownerId,
    photoId: item.id,
    albumId: item.albumId,
    originalPrice: item.price,
    discountPrice: Math.round(item.price * (100 - discountPercent) / 100),
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
  const productPhotos = photos.slice(1, 10);

  if (pricesByNumber.size === 0) {
    console.warn(`Warning: prices were not parsed for post ${post.id}`);
  }

  if (productPhotos.length < 9) {
    console.warn(`Expected 9 product photos, found ${productPhotos.length}`);
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

function isRoulettePost(post) {
  return String(post.text || '').includes('#CP_СкидочнаяРулетка');
}

async function getRecentWallPosts(limit = 3) {
  const response = await vkRead('wall.get', {
    owner_id: -Math.abs(GROUP_ID),
    count: limit,
  });

  await sleep(1000);

  return response.items || [];
}

async function getWallPostById(postId) {
  const response = await vkRead('wall.getById', {
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
    const result = importPublishedPost({
      vkPostId: post.id,
      publishDate: post.date,
      publishDateText: formatPublishDate(post.date),
      items,
    });

    syncedPostIds.push(post.id);

    if (result.saved) {
      console.log(`Imported post ${post.id}: ${items.length} items`);
    } else if (result.reason === 'duplicate') {
      console.log(`Post ${post.id} already exists, skipped`);
      const existingItems = getPostItems(post.id);

      if (existingItems.length < 9) {
        console.warn(`post_items less than 9 for post ${post.id}, reimporting`);
        items = buildImportedPostItems(post);
        replacePostItems(post.id, items);
        console.log(`Reimported post ${post.id}: ${items.length} items`);
      }
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
  const recentPostIds = await syncRecentRoulettePosts();

  if (recentPostIds.length === 0) {
    console.log('No recent roulette posts found');
    return;
  }

  await sleep(1000);

  const posts = listPostsForReservationFixByIds(recentPostIds);

  if (posts.length === 0) {
    console.log('No imported recent roulette posts found in DB');
    return;
  }

  await fixReservations(posts);
}

function parseReservationItemNumber(text = '') {
  const normalized = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\d]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/^[1-9]$/.test(normalized)) {
    return Number(normalized);
  }

  const patterns = [
    /(?:^|\s)(?:бронь|лот|номер)\s+([1-9])(?:\s|$)/u,
    /(?:^|\s)([1-9])\s+(?:бронь|лот|номер)(?:\s|$)/u,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);

    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

function looksLikeReservationComment(text = '') {
  const normalized = String(text).toLowerCase();
  const keywords = ['бронь', 'заберу', 'отложите', 'мне', 'беру'];

  return parseReservationItemNumber(text) !== null
    || keywords.some((keyword) => normalized.includes(keyword));
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
    const response = await vkRead('wall.getComments', {
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

async function getPhotoComments(item) {
  const count = 100;
  let offset = 0;
  const comments = [];

  while (true) {
    const response = await vkRead('photos.getComments', {
      owner_id: item.photo_owner_id,
      photo_id: item.photo_id,
      count,
      offset,
      sort: 'asc',
    });

    comments.push(...response.items);

    if (comments.length >= response.count || response.items.length === 0) {
      break;
    }

    offset += response.items.length;
  }

  return comments;
}

async function photoAlreadyHasReservationComment(item) {
  const comments = await getPhotoComments(item);
  await waitToAvoidVkRateLimit(2000);

  return comments.some((comment) => String(comment.text || '').toLowerCase().includes('бронь'));
}

async function createPhotoReservationComment(item, displayName) {
  const message = `${displayName} — бронь ${item.discount_price} ₽`;

  return vk('photos.createComment', {
    owner_id: item.photo_owner_id,
    photo_id: item.photo_id,
    message,
    from_group: Math.abs(GROUP_ID),
  }, ACCESS_TOKEN);
}

async function replyToReservationComment(postId, comment) {
  const displayName = comment.mentionName || comment.userName || comment.reservationName || `id${comment.from_id}`;
  const message = `[id${comment.from_id}|${displayName}], укажите номер лота, пожалуйста. Например: 6 бронь`;

  return vk('wall.createComment', {
    owner_id: -Math.abs(GROUP_ID),
    post_id: postId,
    reply_to_comment: comment.id,
    message,
    from_group: Math.abs(GROUP_ID),
  }, ACCESS_TOKEN);
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
      `raw_comment=${reservation.raw_comment || ''}`,
    ].join(' | '));
  });
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
    console.log(`photo_comment: ${reservation.displayName || reservation.userName} — бронь ${item.discount_price} ₽`);
  }
}

async function finalizeConfirmedReservation({ reservation, item, mode }) {
  let alreadyReserved = false;

  try {
    alreadyReserved = await photoAlreadyHasReservationComment(item);
  } catch (error) {
    console.warn(`Could not read photo comments for ${item.photo_attachment}: ${error.message || error}`);
  }

  if (alreadyReserved) {
    console.warn('photo already has reservation comment');
  }

  printReservationAction(mode, reservation, item);

  if (!DRY_RUN && !alreadyReserved) {
    await createPhotoReservationComment(item, reservation.displayName || reservation.userName);
    await waitToAvoidVkRateLimit(2000);
  }
}

async function fixReservations(postsOverride = null) {
  const posts = Array.isArray(postsOverride) ? postsOverride : listPostsForReservationFix();

  if (posts.length === 0) {
    console.log('No scheduled posts found in DB');
    return;
  }

  console.log(`FIX RESERVATIONS ${DRY_RUN ? 'DRY-RUN' : 'REAL RUN'}`);
  console.log(`posts: ${posts.length}`);

  if (SKIP_UNRESOLVED_REPLIES) {
    console.log('SKIP_UNRESOLVED_REPLIES=true: unresolved replies disabled');
  }

  const stats = {
    roulettePosts: posts.length,
    commentsChecked: 0,
    confirmed: 0,
    unresolved: 0,
    skippedDuplicates: 0,
  };

  for (const post of posts) {
    const items = getPostItems(post.vk_post_id);
    const itemsByNumber = new Map(items.map((item) => [Number(item.item_number), item]));
    const foundItemNumbers = new Set();
    let comments = [];

    try {
      comments = await getWallComments(post.vk_post_id);
    } catch (error) {
      console.warn(`Could not read comments for post ${post.vk_post_id}: ${error.message || error}`);
      continue;
    }

    console.log('');
    console.log(`POST ${post.vk_post_id}`);
    console.log(`status: ${post.status}`);
    console.log(`publish_date_text: ${post.publish_date_text}`);
    console.log(`comments: ${comments.length}`);
    stats.commentsChecked += comments.length;

    for (const comment of comments) {
      if (comment.from_id === -Math.abs(GROUP_ID)) {
        continue;
      }

      const itemNumber = parseReservationItemNumber(comment.text);
      const isReservationLike = looksLikeReservationComment(comment.text);

      if (!itemNumber && !isReservationLike) {
        continue;
      }

      const existingReservation = getReservationByCommentId(post.vk_post_id, comment.id);

      if (existingReservation) {
        if (existingReservation.status === 'confirmed') {
          console.log(`Reservation already confirmed for comment ${comment.id}, skipped`);
          stats.skippedDuplicates += 1;
          continue;
        }

        if (existingReservation.status === 'unresolved') {
          console.log('existing unresolved reservation, rechecking comment');

          if (!itemNumber) {
            if (!DRY_RUN) {
              const shouldReply = !existingReservation.reply_sent_at && !SKIP_UNRESOLVED_REPLIES;
              updateReservationUnresolvedComment({
                vkPostId: post.vk_post_id,
                commentId: comment.id,
                rawComment: comment.text || '',
                replySentAt: shouldReply ? Math.floor(Date.now() / 1000) : null,
              });

              if (shouldReply) {
                await replyToReservationComment(post.vk_post_id, comment);
                await waitToAvoidVkRateLimit(2000);
              }
            }
            stats.unresolved += 1;
            continue;
          }

          const item = itemsByNumber.get(itemNumber);

          if (!item) {
            if (!DRY_RUN) {
              const shouldReply = !existingReservation.reply_sent_at && !SKIP_UNRESOLVED_REPLIES;
              updateReservationUnresolvedComment({
                vkPostId: post.vk_post_id,
                commentId: comment.id,
                rawComment: comment.text || '',
                replySentAt: shouldReply ? Math.floor(Date.now() / 1000) : null,
              });

              if (shouldReply) {
                await replyToReservationComment(post.vk_post_id, comment);
                await waitToAvoidVkRateLimit(2000);
              }
            }
            stats.unresolved += 1;
            continue;
          }

          console.log(`resolved unresolved reservation: item_number ${itemNumber}`);

          const reservation = buildReservationRecord({
            postId: post.vk_post_id,
            comment,
            item,
            status: 'confirmed',
          });

          if (!DRY_RUN) {
            updateReservationResolved(reservation);
          }

          await finalizeConfirmedReservation({
            reservation,
            item,
            mode: DRY_RUN ? 'Would resolve unresolved reservation' : 'Resolved unresolved reservation',
          });
          stats.confirmed += 1;
          continue;
        }
      }

      const item = itemNumber ? itemsByNumber.get(itemNumber) : null;

      if (!item) {
        const reservation = buildReservationRecord({
          postId: post.vk_post_id,
          comment,
          item: null,
          status: 'unresolved',
        });

        printReservationAction(DRY_RUN ? 'Would save unresolved reservation' : 'Unresolved reservation', reservation, null);

        if (!DRY_RUN) {
          reservation.replySentAt = SKIP_UNRESOLVED_REPLIES ? null : Math.floor(Date.now() / 1000);
          saveReservation(reservation);

          if (!SKIP_UNRESOLVED_REPLIES) {
            await replyToReservationComment(post.vk_post_id, comment);
            await waitToAvoidVkRateLimit(2000);
          }
        }

        stats.unresolved += 1;
        continue;
      }

      if (foundItemNumbers.has(itemNumber)) {
        console.warn(`Warning: duplicate reservation for item ${itemNumber}`);
      }

      foundItemNumbers.add(itemNumber);

      const reservation = buildReservationRecord({
        postId: post.vk_post_id,
        comment,
        item,
        status: 'confirmed',
      });

      if (!DRY_RUN) {
        saveReservation(reservation);
      }

      await finalizeConfirmedReservation({
        reservation,
        item,
        mode: DRY_RUN ? 'Would save confirmed reservation' : 'Confirmed reservation',
      });
      stats.confirmed += 1;
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
      <text x="540" y="594" text-anchor="middle" font-family="Russo One, Arial, sans-serif" font-size="54" fill="#fff7ed" stroke="#451a03" stroke-width="1.2" paint-order="stroke">${escapeSvgText('🎲')}</text>
      <path d="${titleTopPath}" fill="#fff7ed" stroke="#451a03" stroke-width="1.5"/>
      <path d="${titleBottomPath}" fill="#fff7ed" stroke="#451a03" stroke-width="1.5"/>
      <path d="${percentPath}" fill="#1c1917" fill-opacity="0.34" transform="translate(0 5)"/>
      <path d="${percentPath}" fill="#fff7ed" stroke="#1c1917" stroke-width="4" filter="url(#softGlow)"/>
      <rect x="418" y="873" width="244" height="42" rx="20" fill="#1c1917" fill-opacity="0.52"/>
      <text x="540" y="901" text-anchor="middle" font-family="Russo One, Arial, sans-serif" font-size="17" fill="#fed7aa" fill-opacity="0.94">${escapeSvgText('каждый день • 20:30')}</text>
      <rect x="772" y="1370" width="212" height="50" rx="20" fill="#111827" fill-opacity="0.66"/>
      <text x="878" y="1403" text-anchor="middle" font-family="Russo One, Arial, sans-serif" font-size="22" fill="#ffffff">${escapeSvgText('⏳ актуально 24 часа')}</text>
    </svg>
  `);
}

async function vk(method, params = {}, accessToken = ACCESS_TOKEN) {
  if (!accessToken) {
    throw new Error('VK_USER_TOKEN пустой');
  }

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await axios.get(`${VK_API_URL}/${method}`, {
      params: {
        ...params,
        access_token: accessToken,
        v: VK_API_VERSION,
      },
    });

    if (response.data.error) {
      const { error_code: code, error_msg: message } = response.data.error;

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

    await sleep(350);
    return response.data.response;
  }

  throw new Error(`VK API request failed: ${method}`);
}

async function vkRead(method, params = {}) {
  return vk(method, params, ACCESS_TOKEN);
}

async function publishDelayedPost(postText, attachments, publishDate) {
  if (!POST_TOKEN) {
    throw new Error('VK_USER_TOKEN пустой');
  }

  return vk('wall.post', {
    owner_id: -Math.abs(GROUP_ID),
    from_group: 1,
    message: postText,
    attachments,
    publish_date: publishDate,
  }, POST_TOKEN);
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
      extended: 0,
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
  const itemsPerPost = Number(options.itemsPerPost || 9);
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

async function createPreviewImage(items, outputPath = PREVIEW_PATH) {
  ensureOutputDir();
  fs.accessSync(RUSSO_ONE_FONT_PATH, fs.constants.R_OK);
  console.log('Russo One font loaded successfully');

  const imageBuffers = await Promise.all(items.map((item) => downloadItemImage(item)));
  const firstBackground = await sharp(imageBuffers[0])
    .resize(PREVIEW_WIDTH, PREVIEW_HEIGHT, { fit: 'cover', position: sharp.strategy.attention })
    .blur(18)
    .modulate({ brightness: 0.62, saturation: 0.68 })
    .jpeg({ quality: 88 })
    .toBuffer();
  const composites = [{ input: firstBackground, left: 0, top: 0 }];

  for (const [index, buffer] of imageBuffers.entries()) {
    const left = SAFE_PADDING + (index % 3) * (CARD_WIDTH + CELL_GAP);
    const top = SAFE_PADDING + Math.floor(index / 3) * (CARD_HEIGHT + CELL_GAP);
    const input = await sharp(buffer)
      .resize(CARD_WIDTH, CARD_HEIGHT, { fit: 'cover', position: sharp.strategy.attention })
      .jpeg({ quality: 90 })
      .toBuffer();

    composites.push({ input, left, top });
  }

  composites.push({
    input: buildOverlaySvg(),
    left: 0,
    top: 0,
  });

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

  return outputPath;
}

async function uploadWallPhoto(filePath) {
  if (!POST_TOKEN) {
    throw new Error('VK_USER_TOKEN пустой');
  }

  const uploadServer = await vk('photos.getWallUploadServer', {
    group_id: Math.abs(GROUP_ID),
  }, POST_TOKEN);

  const form = new FormData();
  form.append('photo', fs.createReadStream(filePath));

  const uploadResponse = await axios.post(uploadServer.upload_url, form, {
    headers: form.getHeaders(),
  });

  if (uploadResponse.data.error) {
    throw new Error(`VK photo upload error: ${uploadResponse.data.error}`);
  }

  const savedPhotos = await vk('photos.saveWallPhoto', {
    group_id: Math.abs(GROUP_ID),
    photo: uploadResponse.data.photo,
    server: uploadResponse.data.server,
    hash: uploadResponse.data.hash,
  }, POST_TOKEN);

  console.log('VK photos.saveWallPhoto response:');
  console.log(JSON.stringify(savedPhotos, null, 2));

  const [photo] = savedPhotos;

  if (!photo) {
    throw new Error('Preview upload failed: photo is undefined');
  }

  const previewAttachment = `photo${photo.owner_id}_${photo.id}`;

  if (!isValidPhotoAttachment(previewAttachment)) {
    throw new Error('Preview upload failed: photo is undefined');
  }

  return previewAttachment;
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

  if (command === 'reservations') {
    printReservationsList();
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

  console.log('TOKEN USAGE:');
  console.log(`photos.get: ${getReadTokenName()}`);
  console.log(`upload preview image: ${getPostTokenName()}`);
  console.log(`wall.post: ${getPostTokenName()}`);
  console.log('');

  const albumIds = Array.isArray(config.albums) ? config.albums : [];
  const itemsPerPost = Number(config.itemsPerPost || 9);
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
    const previewPath = await createPreviewImage(plan.items, plan.previewPath);
    let previewAttachment = '';
    let publishResult = null;
    let actualPublishTimestamp = plan.publishTimestamp;
    let uploadFailed = false;

    if (!DRY_RUN) {
      try {
        previewAttachment = await uploadWallPhoto(previewPath);
        await sleep(1000);
      } catch (error) {
        uploadFailed = true;
        console.error(error.message || error);
      }

      if (uploadFailed || !isValidPhotoAttachment(previewAttachment)) {
        console.error('Preview upload failed: photo is undefined');
        nextPublishDate = addDays(nextPublishDate, 1);
      } else {
        const attachmentsForPost = buildWallAttachments(plan.items, previewAttachment);
        const attachmentsInfo = getAttachmentsInfo(attachmentsForPost);

        console.log('ATTACHMENTS BEFORE WALL.POST:');
        console.log(`count: ${attachmentsInfo.count}`);
        console.log(`first: ${attachmentsInfo.first}`);

        publishResult = await publishDelayedPostSkippingTakenDates(plan.postText, attachmentsForPost, nextPublishDate);
        nextPublishDate = addDays(publishResult.publishDate, 1);
        actualPublishTimestamp = publishResult.publishTimestamp;
      }
    }

    const attachments = buildWallAttachments(plan.items, previewAttachment);

    console.log('');
    console.log(`POST #${plan.index}`);
    console.log('PUBLISH_DATE:');
    console.log(`${actualPublishTimestamp} (${formatPublishDate(actualPublishTimestamp)})`);
    console.log('');
    console.log('SELECTED ITEMS:');
    console.log(formatItemList(plan.items));
    console.log('');
    console.log('PREVIEW IMAGE:');
    console.log(previewPath);
    console.log('');
    console.log('ATTACHMENTS:');
    console.log(attachments);

    if (DRY_RUN) {
      printDbSavePreview(null, actualPublishTimestamp, formatPublishDate(actualPublishTimestamp), buildDbItems(plan.items));
      console.log('');
      console.log('DRY_RUN=true: preview was not uploaded and wall.post was not created');
      continue;
    }

    if (!publishResult) {
      console.log('');
      console.log('Post skipped because preview upload failed');
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
  buildPostText,
  buildWallAttachments,
  createPreviewImage,
  buildScheduledPostPlans,
  uploadWallPhoto,
  getAllAvailableItems,
  publishDelayedPost,
  parseReservationItemNumber,
  fixReservations,
  syncRecentRoulettePosts,
  fixRecentReservations,
  reimportPostItems,
};
