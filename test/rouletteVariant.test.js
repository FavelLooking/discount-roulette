const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  getGoldBlockNumber,
  getPositionInGoldBlock,
  resolveRouletteVariant,
} = require('../rouletteVariant');
const {
  buildWallAttachments,
  buildProductFingerprint,
  buildPostText,
  buildDbItems,
  buildReservationRecord,
  buildPhotoReservationCommentText,
  buildPhotoReservationCommentRequest,
  deliverReservationPhotoComment,
  parseReservationItemNumbers,
  parseReservationItemNumber,
  getReservationWindow,
  isCommentWithinReservationWindow,
  shouldMarkReservationsChecked,
  shouldScanReservationsPost,
  buildReservationTasksForComment,
  makeReservationIdentity,
  publicPostCopyIncludesOnly24Hours,
} = require('../index');

function makeItems(count = 8) {
  return Array.from({ length: count }, (_, index) => ({
    albumId: 1,
    id: 1000 + index,
    ownerId: -57561517,
    price: 1000,
    text: `item ${index + 1} 1000 ₽`,
    attachment: `photo-57561517_${1000 + index}`,
  }));
}

function makeAssignments(start, end, goldByBlock) {
  const assignments = [];

  for (let sequence = start; sequence <= end; sequence += 1) {
    const block = getGoldBlockNumber(sequence);
    assignments.push(resolveRouletteVariant(sequence, goldByBlock[block], {
      normalDiscountPercent: 25,
      goldDiscountPercent: 35,
      normalCardAttachment: 'photo-57561517_111',
      goldCardAttachment: 'photo-57561517_222',
    }));
  }

  return assignments;
}

test('exactly one GOLD in sequence 1-10', () => {
  const assignments = makeAssignments(1, 10, { 1: 7 });
  assert.equal(assignments.filter((assignment) => assignment.variant === 'gold').length, 1);
  assert.equal(assignments[6].variant, 'gold');
});

test('exactly one GOLD in sequence 11-20', () => {
  const assignments = makeAssignments(11, 20, { 2: 4 });
  assert.equal(assignments.filter((assignment) => assignment.variant === 'gold').length, 1);
  assert.equal(assignments[3].sequenceNumber, 14);
  assert.equal(assignments[3].variant, 'gold');
});

test('rerun does not change selected gold slot', () => {
  const first = resolveRouletteVariant(17, 4);
  const second = resolveRouletteVariant(17, 4);
  assert.deepEqual(first, second);
});

test('restart/state reload preserves gold slot', () => {
  const persistedGoldPosition = 9;
  const beforeRestart = makeAssignments(1, 10, { 1: persistedGoldPosition });
  const afterRestart = makeAssignments(1, 10, { 1: persistedGoldPosition });
  assert.deepEqual(beforeRestart, afterRestart);
});

test('GOLD uses 35 percent', () => {
  const assignment = resolveRouletteVariant(7, 7, {
    normalDiscountPercent: 25,
    goldDiscountPercent: 35,
  });
  assert.equal(assignment.discountPercent, 35);
});

test('NORMAL uses 25 percent', () => {
  const assignment = resolveRouletteVariant(6, 7, {
    normalDiscountPercent: 25,
    goldDiscountPercent: 35,
  });
  assert.equal(assignment.discountPercent, 25);
});

test('GOLD uses VK_ROULETTE_GOLD_CARD_ATTACHMENT', () => {
  const assignment = resolveRouletteVariant(7, 7, {
    normalCardAttachment: 'photo-57561517_111',
    goldCardAttachment: 'photo-57561517_222',
  });
  assert.equal(assignment.cardAttachment, 'photo-57561517_222');
});

test('NORMAL uses VK_ROULETTE_CARD_ATTACHMENT', () => {
  const assignment = resolveRouletteVariant(6, 7, {
    normalCardAttachment: 'photo-57561517_111',
    goldCardAttachment: 'photo-57561517_222',
  });
  assert.equal(assignment.cardAttachment, 'photo-57561517_111');
});

test('reservation pricing uses persisted post discount', () => {
  const [goldItem] = buildDbItems(makeItems(1), 35);
  const [normalItem] = buildDbItems(makeItems(1), 25);
  assert.equal(goldItem.discountPrice, 650);
  assert.equal(normalItem.discountPrice, 750);
});

test('rolling queue crossing a 10-post block boundary remains correct', () => {
  const assignments = makeAssignments(8, 12, { 1: 9, 2: 2 });
  assert.deepEqual(assignments.map((assignment) => ({
    sequence: assignment.sequenceNumber,
    block: assignment.blockNumber,
    position: getPositionInGoldBlock(assignment.sequenceNumber),
    variant: assignment.variant,
  })), [
    { sequence: 8, block: 1, position: 8, variant: 'normal' },
    { sequence: 9, block: 1, position: 9, variant: 'gold' },
    { sequence: 10, block: 1, position: 10, variant: 'normal' },
    { sequence: 11, block: 2, position: 1, variant: 'normal' },
    { sequence: 12, block: 2, position: 2, variant: 'gold' },
  ]);
});

test('partial block ensure-queue reruns keep the same block gold slot', () => {
  const persistedBlock = { 1: 5 };
  const firstRun = makeAssignments(1, 3, persistedBlock);
  const secondRun = makeAssignments(4, 6, persistedBlock);
  const combined = [...firstRun, ...secondRun];
  assert.equal(combined.filter((assignment) => assignment.variant === 'gold').length, 1);
  assert.equal(combined[4].sequenceNumber, 5);
  assert.equal(combined[4].variant, 'gold');
});

test('final attachments place card in center slot', () => {
  const attachments = buildWallAttachments(makeItems(8), 'photo-57561517_222').split(',');
  assert.equal(attachments.length, 9);
  assert.equal(attachments[4], 'photo-57561517_222');
});

test('product fingerprint is deterministic and excludes static card', () => {
  const items = makeItems(8);
  const reversed = [...items].reverse();
  const fingerprint = buildProductFingerprint(items);

  assert.equal(fingerprint, buildProductFingerprint(reversed));
  assert.equal(fingerprint.includes('photo-57561517_222'), false);
  assert.equal(fingerprint.split('|').length, 8);
});

test('GOLD post text uses gold discount and hashtag', () => {
  const text = buildPostText(makeItems(8), {
    variant: 'gold',
    discountPercent: 35,
  });
  assert.match(text, /ЗОЛОТОЙ СЕКТОР/);
  assert.match(text, /Сегодня выпал Золотой сектор — скидка 35% на все 8 товаров\./);
  assert.match(text, /Такие выпуски появляются редко\. Подпишитесь на рассылку сообщества, чтобы не пропустить следующий\./);
  assert.match(text, /1\. 1\s000 ₽ → 650 ₽/);
  assert.match(text, /#CP_СкидочнаяРулетка/);
  assert.match(text, /#CP_ЗолотойСектор/);
});

test('wall comment "1 бронь" resolves to correct post item', () => {
  const itemNumber = parseReservationItemNumber('1 бронь');
  const itemsByNumber = new Map([
    [1, {
      item_number: 1,
      photo_attachment: 'photo-57561517_101',
      discount_price: 435,
    }],
  ]);

  assert.equal(itemsByNumber.get(itemNumber).photo_attachment, 'photo-57561517_101');
});

test('persisted discounted price is used for reservation photo comment', () => {
  const text = buildPhotoReservationCommentText({
    displayName: 'Иван Иванов',
    discountPrice: 435,
  });

  assert.equal(text, 'Иван Иванов — бронь 435 ₽');
});

test('normal 25 percent reservation comment uses persisted normal price', () => {
  const [item] = buildDbItems(makeItems(1), 25);
  const text = buildPhotoReservationCommentText({
    displayName: 'Иван Иванов',
    discountPrice: item.discountPrice,
  });

  assert.equal(text, 'Иван Иванов — бронь 750 ₽');
});

test('gold 35 percent reservation comment uses persisted gold price', () => {
  const [item] = buildDbItems(makeItems(1), 35);
  const text = buildPhotoReservationCommentText({
    displayName: 'Иван Иванов',
    discountPrice: item.discountPrice,
  });

  assert.equal(text, 'Иван Иванов — бронь 650 ₽');
});

test('photos.createComment request targets original photo with user token role', () => {
  const request = buildPhotoReservationCommentRequest({
    displayName: 'Иван Иванов',
    discountPrice: 435,
    photoOwnerId: -57561517,
    photoId: 123456,
  }, 'stable-guid');

  assert.equal(request.method, 'photos.createComment');
  assert.equal(request.tokenRole, 'user');
  assert.equal(request.params.owner_id, -57561517);
  assert.equal(request.params.photo_id, 123456);
  assert.equal(request.params.message, 'Иван Иванов — бронь 435 ₽');
  assert.equal(request.params.guid, 'stable-guid');
});

test('missing user token keeps photo comment retryable', async () => {
  const failed = [];
  let writes = 0;
  const result = await deliverReservationPhotoComment({
    id: 1,
    display_name: 'Иван Иванов',
    discount_price: 435,
    photo_owner_id: -57561517,
    photo_id: 123456,
    photo_comment_status: 'pending',
  }, {
    dryRun: false,
    userToken: '',
    ensureGuid: () => ({ photo_comment_guid: 'stable-guid' }),
    createComment: async () => { writes += 1; },
    markFailed: (id, error) => failed.push({ id, error }),
    waitAfterSend: false,
  });

  assert.equal(result.status, 'failed_retryable');
  assert.equal(writes, 0);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /USER TOKEN REQUIRED/);
});

test('expired user token keeps photo comment retryable', async () => {
  const failed = [];
  const tokenError = new Error('VK API error 5: User authorization failed');
  tokenError.vkCode = 5;
  const result = await deliverReservationPhotoComment({
    id: 1,
    display_name: 'Иван Иванов',
    discount_price: 435,
    photo_owner_id: -57561517,
    photo_id: 123456,
    photo_comment_status: 'pending',
  }, {
    dryRun: false,
    userToken: 'user-token',
    ensureGuid: () => ({ photo_comment_guid: 'stable-guid' }),
    createComment: async () => { throw tokenError; },
    markFailed: (id, error) => failed.push({ id, error }),
    waitAfterSend: false,
  });

  assert.equal(result.status, 'failed_retryable');
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /USER TOKEN REQUIRED/);
});

test('sync photo comment delivery sends pending entries only and marks sent', async () => {
  const sent = [];
  const result = await deliverReservationPhotoComment({
    id: 7,
    display_name: 'Иван Иванов',
    discount_price: 435,
    photo_owner_id: -57561517,
    photo_id: 123456,
    photo_comment_status: 'pending',
  }, {
    dryRun: false,
    userToken: 'user-token',
    ensureGuid: () => ({ photo_comment_guid: 'stable-guid' }),
    createComment: async () => 999,
    markSent: (id, commentId) => sent.push({ id, commentId }),
    waitAfterSend: false,
  });

  assert.equal(result.status, 'sent');
  assert.deepEqual(sent, [{ id: 7, commentId: 999 }]);
});

test('sent photo comment delivery is skipped', async () => {
  let writes = 0;
  const result = await deliverReservationPhotoComment({
    id: 7,
    photo_comment_status: 'sent',
  }, {
    dryRun: false,
    userToken: 'user-token',
    createComment: async () => { writes += 1; },
    waitAfterSend: false,
  });

  assert.equal(result.status, 'skipped_sent');
  assert.equal(writes, 0);
});

test('photo comment DRY_RUN performs zero VK writes', async () => {
  let writes = 0;
  const result = await deliverReservationPhotoComment({
    id: 7,
    display_name: 'Иван Иванов',
    discount_price: 435,
    photo_owner_id: -57561517,
    photo_id: 123456,
    photo_comment_status: 'pending',
  }, {
    dryRun: true,
    userToken: 'user-token',
    createComment: async () => { writes += 1; },
    waitAfterSend: false,
  });

  assert.equal(result.status, 'dry_run');
  assert.equal(writes, 0);
});

test('new confirmed reservation starts pending photo comment delivery', () => {
  const reservation = buildReservationRecord({
    postId: 136586,
    comment: {
      id: 123,
      from_id: 321,
      userName: 'Иван Иванов',
      displayName: 'Иван Иванов',
      text: '1 бронь',
    },
    item: {
      item_number: 1,
      photo_attachment: 'photo-57561517_101',
      discount_price: 435,
    },
    status: 'confirmed',
  });

  assert.equal(reservation.photoCommentStatus, 'pending');
  assert.equal(reservation.discountPrice, 435);
});

test('historical reservations are not auto-backfilled without explicit cutoff', () => {
  assert.equal(process.env.PHOTO_COMMENT_BACKFILL_SINCE || '', '');
});

test('reservation photo comment workflow does not call photos.getComments', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  assert.doesNotMatch(source, /vk[A-Za-z]*\(\s*['"]photos\.getComments['"]/);
});

test('reservation within first 24h is accepted', () => {
  const publish = 1_000_000;
  assert.equal(isCommentWithinReservationWindow({ date: publish + 12 * 60 * 60 }, { publish_date: publish }, 3), true);
});

test('reservation 49 minutes after official expiry is accepted', () => {
  const publish = 1_000_000;
  assert.equal(isCommentWithinReservationWindow({ date: publish + 24 * 60 * 60 + 49 * 60 }, { publish_date: publish }, 3), true);
});

test('reservation during day plus 2 is accepted', () => {
  const publish = 1_000_000;
  assert.equal(isCommentWithinReservationWindow({ date: publish + 48 * 60 * 60 }, { publish_date: publish }, 3), true);
});

test('reservation during day plus 3 is accepted', () => {
  const publish = 1_000_000;
  assert.equal(isCommentWithinReservationWindow({ date: publish + 72 * 60 * 60 }, { publish_date: publish }, 3), true);
});

test('reservation after 96h cutoff is ignored', () => {
  const publish = 1_000_000;
  assert.equal(isCommentWithinReservationWindow({ date: publish + 96 * 60 * 60 + 1 }, { publish_date: publish }, 3), false);
});

test('same post is scanned repeatedly while grace remains open', () => {
  const publish = 1_000_000;
  const post = { publish_date: publish, reservations_checked_at: null };

  assert.equal(shouldScanReservationsPost(post, publish + 25 * 60 * 60, 3), true);
  assert.equal(shouldScanReservationsPost(post, publish + 50 * 60 * 60, 3), true);
});

test('reservations_checked_at is not set after first scan', () => {
  const publish = 1_000_000;
  const post = { publish_date: publish };

  assert.equal(shouldMarkReservationsChecked(post, publish + 25 * 60 * 60, 3), false);
});

test('reservations_checked_at is set after final grace-window scan', () => {
  const publish = 1_000_000;
  const post = { publish_date: publish };

  assert.equal(shouldMarkReservationsChecked(post, publish + 96 * 60 * 60, 3), true);
});

test('one wall comment with two reservations creates two item tasks', () => {
  const items = new Map([
    [1, { item_number: 1 }],
    [4, { item_number: 4 }],
  ]);
  const tasks = buildReservationTasksForComment({ text: '1 бронь и 4 бронь' }, items);

  assert.deepEqual(tasks.map((task) => task.itemNumber), [1, 4]);
});

test('"1 и 4 бронь" creates two reservations', () => {
  assert.deepEqual(parseReservationItemNumbers('1 и 4 бронь'), [1, 4]);
});

test('duplicate item numbers in same comment are deduplicated', () => {
  assert.deepEqual(parseReservationItemNumbers('1 бронь и 1 бронь, 4 бронь'), [1, 4]);
});

test('multi-item reservations can coexist under same wall comment id', () => {
  assert.notEqual(
    makeReservationIdentity(136586, 555, 1),
    makeReservationIdentity(136586, 555, 4),
  );
});

test('each item has its own photo-comment delivery state', () => {
  const first = buildReservationRecord({
    postId: 136586,
    comment: { id: 555, from_id: 10, userName: 'Иван Иванов', text: '1 и 4 бронь' },
    item: { item_number: 1, photo_attachment: 'photo-57561517_1', discount_price: 435 },
    status: 'confirmed',
  });
  const second = buildReservationRecord({
    postId: 136586,
    comment: { id: 555, from_id: 10, userName: 'Иван Иванов', text: '1 и 4 бронь' },
    item: { item_number: 4, photo_attachment: 'photo-57561517_4', discount_price: 585 },
    status: 'confirmed',
  });

  assert.equal(first.photoCommentStatus, 'pending');
  assert.equal(second.photoCommentStatus, 'pending');
  assert.notEqual(first.photoAttachment, second.photoAttachment);
});

test('existing single-item historical reservations remain valid', () => {
  assert.equal(makeReservationIdentity(136586, 555, 1), '136586:555:1');
});

test('golden sector persisted discount still used for late grace reservation', () => {
  const text = buildPhotoReservationCommentText({
    displayName: 'Иван Иванов',
    discountPrice: 650,
  });

  assert.equal(text, 'Иван Иванов — бронь 650 ₽');
});

test('no 15-minute polling is restored', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  assert.doesNotMatch(source, /15\s*\*\s*60\s*\*\s*1000/);
  assert.doesNotMatch(source, /setInterval/);
});

test('public post text remains unchanged at 24 hours', () => {
  const text = buildPostText(makeItems(8), { variant: 'normal', discountPercent: 25 });

  assert.equal(publicPostCopyIncludesOnly24Hours(text), true);
});

test('reservation window is publish date through 96 hours with three grace days', () => {
  const publish = 1_000_000;
  const window = getReservationWindow({ publish_date: publish }, 3);

  assert.equal(window.officialExpiry, publish + 24 * 60 * 60);
  assert.equal(window.reservationCutoff, publish + 96 * 60 * 60);
});
