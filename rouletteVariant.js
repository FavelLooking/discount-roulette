const GOLD_BLOCK_SIZE = 10;
const NORMAL_VARIANT = 'normal';
const GOLD_VARIANT = 'gold';

function getGoldBlockNumber(sequenceNumber, blockSize = GOLD_BLOCK_SIZE) {
  return Math.floor((Number(sequenceNumber) - 1) / blockSize) + 1;
}

function getPositionInGoldBlock(sequenceNumber, blockSize = GOLD_BLOCK_SIZE) {
  return ((Number(sequenceNumber) - 1) % blockSize) + 1;
}

function createGoldPosition(random = Math.random, blockSize = GOLD_BLOCK_SIZE) {
  return Math.floor(random() * blockSize) + 1;
}

function resolveRouletteVariant(sequenceNumber, goldPosition, options = {}) {
  const normalDiscountPercent = Number(options.normalDiscountPercent ?? 25);
  const goldDiscountPercent = Number(options.goldDiscountPercent ?? 35);
  const normalCardAttachment = options.normalCardAttachment || '';
  const goldCardAttachment = options.goldCardAttachment || '';
  const position = getPositionInGoldBlock(sequenceNumber, options.blockSize || GOLD_BLOCK_SIZE);
  const isGold = position === Number(goldPosition);
  const variant = isGold ? GOLD_VARIANT : NORMAL_VARIANT;

  return {
    sequenceNumber: Number(sequenceNumber),
    blockNumber: getGoldBlockNumber(sequenceNumber, options.blockSize || GOLD_BLOCK_SIZE),
    position,
    goldPosition: Number(goldPosition),
    variant,
    isGold,
    discountPercent: isGold ? goldDiscountPercent : normalDiscountPercent,
    cardAttachment: isGold ? goldCardAttachment : normalCardAttachment,
  };
}

module.exports = {
  GOLD_BLOCK_SIZE,
  NORMAL_VARIANT,
  GOLD_VARIANT,
  getGoldBlockNumber,
  getPositionInGoldBlock,
  createGoldPosition,
  resolveRouletteVariant,
};
