const test = require('node:test');
const assert = require('node:assert/strict');

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
