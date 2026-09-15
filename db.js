const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.ROULETTE_DB_PATH || path.join(__dirname, 'data', 'roulette.sqlite');
const DATA_DIR = path.dirname(DB_PATH);

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function openDb() {
  ensureDataDir();

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vk_post_id INTEGER,
      publish_date INTEGER,
      publish_date_text TEXT,
      delete_after INTEGER,
      status TEXT,
      created_at INTEGER,
      reservations_checked_at INTEGER,
      variant TEXT,
      discount_percent INTEGER,
      card_attachment TEXT,
      roulette_sequence_number INTEGER,
      gold_block_number INTEGER,
      gold_position INTEGER,
      product_fingerprint TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_posts_vk_post_id
      ON scheduled_posts(vk_post_id);

    CREATE TABLE IF NOT EXISTS post_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vk_post_id INTEGER,
      item_number INTEGER,
      photo_attachment TEXT,
      photo_owner_id INTEGER,
      photo_id INTEGER,
      album_id INTEGER,
      original_price INTEGER,
      discount_price INTEGER,
      photo_text TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_post_items_vk_post_id
      ON post_items(vk_post_id);

    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vk_post_id INTEGER,
      comment_id INTEGER,
      user_id INTEGER,
      user_name TEXT,
      display_name TEXT,
      item_number INTEGER,
      photo_attachment TEXT,
      discount_price INTEGER,
      status TEXT,
      raw_comment TEXT,
      created_at INTEGER,
      fixed_at INTEGER,
      reply_sent_at INTEGER,
      photo_comment_status TEXT,
      photo_comment_id INTEGER,
      photo_comment_sent_at INTEGER,
      photo_comment_last_error TEXT,
      photo_comment_guid TEXT
    );

    DROP INDEX IF EXISTS idx_reservations_post_comment;

    CREATE INDEX IF NOT EXISTS idx_reservations_post_comment_lookup
      ON reservations(vk_post_id, comment_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_post_comment_item
      ON reservations(vk_post_id, comment_id, item_number);

    CREATE INDEX IF NOT EXISTS idx_reservations_vk_post_id
      ON reservations(vk_post_id);

    CREATE TABLE IF NOT EXISTS used_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_attachment TEXT,
      photo_id INTEGER,
      vk_post_id INTEGER,
      used_at INTEGER,
      state TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_used_items_photo_attachment
      ON used_items(photo_attachment);

    CREATE TABLE IF NOT EXISTS vk_api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER,
      operation TEXT,
      method TEXT,
      token_type TEXT,
      success INTEGER,
      vk_error_code INTEGER,
      error_kind TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_vk_api_usage_timestamp
      ON vk_api_usage(timestamp);

    CREATE TABLE IF NOT EXISTS roulette_gold_blocks (
      block_number INTEGER PRIMARY KEY,
      gold_position INTEGER NOT NULL,
      created_at INTEGER
    );
  `);

  const scheduledPostColumns = db.prepare('PRAGMA table_info(scheduled_posts)').all();
  const hasReservationsCheckedAt = scheduledPostColumns.some((column) => column.name === 'reservations_checked_at');
  const hasVariant = scheduledPostColumns.some((column) => column.name === 'variant');
  const hasDiscountPercent = scheduledPostColumns.some((column) => column.name === 'discount_percent');
  const hasCardAttachment = scheduledPostColumns.some((column) => column.name === 'card_attachment');
  const hasRouletteSequenceNumber = scheduledPostColumns.some((column) => column.name === 'roulette_sequence_number');
  const hasGoldBlockNumber = scheduledPostColumns.some((column) => column.name === 'gold_block_number');
  const hasGoldPosition = scheduledPostColumns.some((column) => column.name === 'gold_position');
  const hasProductFingerprint = scheduledPostColumns.some((column) => column.name === 'product_fingerprint');
  const reservationColumns = db.prepare('PRAGMA table_info(reservations)').all();
  const hasReplySentAt = reservationColumns.some((column) => column.name === 'reply_sent_at');
  const hasDisplayName = reservationColumns.some((column) => column.name === 'display_name');
  const hasPhotoCommentStatus = reservationColumns.some((column) => column.name === 'photo_comment_status');
  const hasPhotoCommentId = reservationColumns.some((column) => column.name === 'photo_comment_id');
  const hasPhotoCommentSentAt = reservationColumns.some((column) => column.name === 'photo_comment_sent_at');
  const hasPhotoCommentLastError = reservationColumns.some((column) => column.name === 'photo_comment_last_error');
  const hasPhotoCommentGuid = reservationColumns.some((column) => column.name === 'photo_comment_guid');
  const usedItemColumns = db.prepare('PRAGMA table_info(used_items)').all();
  const hasUsedItemState = usedItemColumns.some((column) => column.name === 'state');

  if (!hasReservationsCheckedAt) {
    db.exec('ALTER TABLE scheduled_posts ADD COLUMN reservations_checked_at INTEGER');
  }

  if (!hasVariant) {
    db.exec('ALTER TABLE scheduled_posts ADD COLUMN variant TEXT');
  }

  if (!hasDiscountPercent) {
    db.exec('ALTER TABLE scheduled_posts ADD COLUMN discount_percent INTEGER');
  }

  if (!hasCardAttachment) {
    db.exec('ALTER TABLE scheduled_posts ADD COLUMN card_attachment TEXT');
  }

  if (!hasRouletteSequenceNumber) {
    db.exec('ALTER TABLE scheduled_posts ADD COLUMN roulette_sequence_number INTEGER');
  }

  if (!hasGoldBlockNumber) {
    db.exec('ALTER TABLE scheduled_posts ADD COLUMN gold_block_number INTEGER');
  }

  if (!hasGoldPosition) {
    db.exec('ALTER TABLE scheduled_posts ADD COLUMN gold_position INTEGER');
  }

  if (!hasProductFingerprint) {
    db.exec('ALTER TABLE scheduled_posts ADD COLUMN product_fingerprint TEXT');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_posts_product_fingerprint
      ON scheduled_posts(product_fingerprint);
  `);

  db.exec(`
    UPDATE scheduled_posts
    SET product_fingerprint = (
      SELECT GROUP_CONCAT(photo_attachment, '|')
      FROM (
        SELECT photo_attachment
        FROM post_items
        WHERE post_items.vk_post_id = scheduled_posts.vk_post_id
          AND photo_attachment IS NOT NULL
          AND photo_attachment != ''
        ORDER BY photo_attachment
      )
    )
    WHERE product_fingerprint IS NULL
      AND EXISTS (
        SELECT 1
        FROM post_items
        WHERE post_items.vk_post_id = scheduled_posts.vk_post_id
      );
  `);

  if (!hasReplySentAt) {
    db.exec('ALTER TABLE reservations ADD COLUMN reply_sent_at INTEGER');
  }

  if (!hasDisplayName) {
    db.exec('ALTER TABLE reservations ADD COLUMN display_name TEXT');
  }

  if (!hasPhotoCommentStatus) {
    db.exec('ALTER TABLE reservations ADD COLUMN photo_comment_status TEXT');
  }

  if (!hasPhotoCommentId) {
    db.exec('ALTER TABLE reservations ADD COLUMN photo_comment_id INTEGER');
  }

  if (!hasPhotoCommentSentAt) {
    db.exec('ALTER TABLE reservations ADD COLUMN photo_comment_sent_at INTEGER');
  }

  if (!hasPhotoCommentLastError) {
    db.exec('ALTER TABLE reservations ADD COLUMN photo_comment_last_error TEXT');
  }

  if (!hasPhotoCommentGuid) {
    db.exec('ALTER TABLE reservations ADD COLUMN photo_comment_guid TEXT');
  }

  if (!hasUsedItemState) {
    db.exec('ALTER TABLE used_items ADD COLUMN state TEXT');
  }

  db.exec(`
    UPDATE used_items
    SET state = COALESCE((
      SELECT
        CASE
          WHEN scheduled_posts.status = 'published' THEN 'published'
          WHEN scheduled_posts.status = 'deleted' THEN 'deleted'
          ELSE 'scheduled'
        END
      FROM scheduled_posts
      WHERE scheduled_posts.vk_post_id = used_items.vk_post_id
    ), 'scheduled')
    WHERE state IS NULL;
  `);

  return db;
}

const db = openDb();

function insertUsedItems(vkPostId, items, usedAt = Math.floor(Date.now() / 1000), state = 'scheduled') {
  const insertUsedItem = db.prepare(`
    INSERT INTO used_items (
      photo_attachment,
      photo_id,
      vk_post_id,
      used_at,
      state
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(photo_attachment) DO UPDATE SET
      photo_id = excluded.photo_id,
      vk_post_id = excluded.vk_post_id,
      used_at = excluded.used_at,
      state = excluded.state
  `);

  items.forEach((item) => {
    insertUsedItem.run(
      item.photoAttachment,
      item.photoId,
      vkPostId,
      usedAt,
      state,
    );
  });
}

function saveScheduledPost({
  vkPostId,
  publishDate,
  publishDateText,
  items,
  variant = 'normal',
  discountPercent = 25,
  cardAttachment = '',
  rouletteSequenceNumber = null,
  goldBlockNumber = null,
  goldPosition = null,
  productFingerprint = null,
}) {
  const existing = db.prepare('SELECT id FROM scheduled_posts WHERE vk_post_id = ?').get(vkPostId);

  if (existing) {
    return {
      saved: false,
      reason: 'duplicate',
    };
  }

  const insertPost = db.prepare(`
    INSERT INTO scheduled_posts (
      vk_post_id,
      publish_date,
      publish_date_text,
      delete_after,
      status,
      created_at,
      variant,
      discount_percent,
      card_attachment,
      roulette_sequence_number,
      gold_block_number,
      gold_position,
      product_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertItem = db.prepare(`
    INSERT INTO post_items (
      vk_post_id,
      item_number,
      photo_attachment,
      photo_owner_id,
      photo_id,
      album_id,
      original_price,
      discount_price,
      photo_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    insertPost.run(
      vkPostId,
      publishDate,
      publishDateText,
      publishDate + 24 * 60 * 60,
      'scheduled',
      Math.floor(Date.now() / 1000),
      variant,
      discountPercent,
      cardAttachment,
      rouletteSequenceNumber,
      goldBlockNumber,
      goldPosition,
      productFingerprint,
    );

    items.forEach((item, index) => {
      insertItem.run(
        vkPostId,
        index + 1,
        item.photoAttachment,
        item.photoOwnerId,
        item.photoId,
        item.albumId,
        item.originalPrice,
        item.discountPrice,
        item.photoText,
      );
    });

    insertUsedItems(vkPostId, items, publishDate);
  });

  transaction();

  return {
    saved: true,
  };
}

function importPublishedPost({
  vkPostId,
  publishDate,
  publishDateText,
  items,
  variant = 'normal',
  discountPercent = 25,
  cardAttachment = '',
  rouletteSequenceNumber = null,
  goldBlockNumber = null,
  goldPosition = null,
  productFingerprint = null,
}) {
  const existing = db.prepare('SELECT id FROM scheduled_posts WHERE vk_post_id = ?').get(vkPostId);

  if (existing) {
    return {
      saved: false,
      reason: 'duplicate',
    };
  }

  const insertPost = db.prepare(`
    INSERT INTO scheduled_posts (
      vk_post_id,
      publish_date,
      publish_date_text,
      delete_after,
      status,
      created_at,
      variant,
      discount_percent,
      card_attachment,
      roulette_sequence_number,
      gold_block_number,
      gold_position,
      product_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertItem = db.prepare(`
    INSERT INTO post_items (
      vk_post_id,
      item_number,
      photo_attachment,
      photo_owner_id,
      photo_id,
      album_id,
      original_price,
      discount_price,
      photo_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    insertPost.run(
      vkPostId,
      publishDate,
      publishDateText,
      publishDate + 24 * 60 * 60,
      'published',
      Math.floor(Date.now() / 1000),
      variant,
      discountPercent,
      cardAttachment,
      rouletteSequenceNumber,
      goldBlockNumber,
      goldPosition,
      productFingerprint,
    );

    items.forEach((item, index) => {
      insertItem.run(
        vkPostId,
        index + 1,
        item.photoAttachment,
        item.photoOwnerId,
        item.photoId,
        item.albumId,
        item.originalPrice,
        item.discountPrice,
        item.photoText,
      );
    });
  });

  transaction();

  return {
    saved: true,
  };
}

function normalizeExportedScheduledPost(post) {
  return {
    vk_post_id: Number(post.vk_post_id),
    publish_date: Number(post.publish_date),
    publish_date_text: post.publish_date_text || '',
    delete_after: Number(post.delete_after),
    status: post.status || 'scheduled',
    created_at: Number(post.created_at || Math.floor(Date.now() / 1000)),
    reservations_checked_at: post.reservations_checked_at ?? null,
    variant: post.variant || 'normal',
    discount_percent: Number(post.discount_percent),
    card_attachment: post.card_attachment || '',
    roulette_sequence_number: Number(post.roulette_sequence_number),
    gold_block_number: Number(post.gold_block_number),
    gold_position: Number(post.gold_position),
    product_fingerprint: post.product_fingerprint || null,
  };
}

function buildFingerprintFromPostItems(items) {
  return items
    .map((item) => String(item.photo_attachment || '').trim())
    .filter(Boolean)
    .sort()
    .join('|');
}

function validateQueueStateExport(queueState) {
  if (!queueState || queueState.schema !== 'discount-roulette.queue-state' || queueState.version !== 1) {
    throw new Error('Invalid queue state export schema/version');
  }

  const scheduledPosts = Array.isArray(queueState.scheduled_posts) ? queueState.scheduled_posts : [];
  const postItems = Array.isArray(queueState.post_items) ? queueState.post_items : [];
  const goldBlocks = Array.isArray(queueState.roulette_gold_blocks) ? queueState.roulette_gold_blocks : [];
  const postIds = new Set();
  const goldBlocksByNumber = new Map(goldBlocks.map((block) => [Number(block.block_number), block]));

  scheduledPosts.forEach((rawPost) => {
    const post = normalizeExportedScheduledPost(rawPost);

    if (!post.vk_post_id) {
      throw new Error('Queue state contains scheduled_post without vk_post_id');
    }

    if (postIds.has(post.vk_post_id)) {
      throw new Error(`Queue state contains duplicate vk_post_id ${post.vk_post_id}`);
    }

    postIds.add(post.vk_post_id);

    if (!['scheduled', 'published'].includes(post.status)) {
      throw new Error(`Queue state post ${post.vk_post_id} has invalid status ${post.status}`);
    }

    if (!['normal', 'gold'].includes(post.variant)) {
      throw new Error(`Queue state post ${post.vk_post_id} has invalid variant ${post.variant}`);
    }

    if (!Number.isFinite(post.discount_percent) || post.discount_percent <= 0) {
      throw new Error(`Queue state post ${post.vk_post_id} has invalid discount_percent`);
    }

    if (!post.card_attachment) {
      throw new Error(`Queue state post ${post.vk_post_id} has empty card_attachment`);
    }

    if (!Number.isFinite(post.roulette_sequence_number) || post.roulette_sequence_number <= 0) {
      throw new Error(`Queue state post ${post.vk_post_id} has invalid roulette_sequence_number`);
    }

    const items = postItems.filter((item) => Number(item.vk_post_id) === post.vk_post_id);

    if (items.length !== 8) {
      throw new Error(`Queue state post ${post.vk_post_id} must have exactly 8 post_items, got ${items.length}`);
    }

    const itemNumbers = new Set(items.map((item) => Number(item.item_number)));
    for (let itemNumber = 1; itemNumber <= 8; itemNumber += 1) {
      if (!itemNumbers.has(itemNumber)) {
        throw new Error(`Queue state post ${post.vk_post_id} is missing item_number ${itemNumber}`);
      }
    }

    const expectedFingerprint = buildFingerprintFromPostItems(items);
    if (!post.product_fingerprint || post.product_fingerprint !== expectedFingerprint) {
      throw new Error(`Queue state post ${post.vk_post_id} has invalid product_fingerprint`);
    }

    const goldBlock = goldBlocksByNumber.get(post.gold_block_number);
    if (!goldBlock || Number(goldBlock.gold_position) !== post.gold_position) {
      throw new Error(`Queue state post ${post.vk_post_id} has missing or mismatched gold block state`);
    }
  });

  postItems.forEach((item) => {
    if (!postIds.has(Number(item.vk_post_id))) {
      throw new Error(`Queue state contains post_item for unknown vk_post_id ${item.vk_post_id}`);
    }
  });

  return true;
}

function getQueueStateExport(now = Math.floor(Date.now() / 1000)) {
  const scheduledPosts = db.prepare(`
    SELECT
      id,
      vk_post_id,
      publish_date,
      publish_date_text,
      delete_after,
      status,
      created_at,
      reservations_checked_at,
      variant,
      discount_percent,
      card_attachment,
      roulette_sequence_number,
      gold_block_number,
      gold_position,
      product_fingerprint
    FROM scheduled_posts
    WHERE status = 'scheduled'
      AND publish_date > ?
    ORDER BY publish_date ASC, id ASC
  `).all(now);
  const vkPostIds = scheduledPosts.map((post) => post.vk_post_id);
  const placeholders = vkPostIds.map(() => '?').join(',');
  const postItems = vkPostIds.length > 0
    ? db.prepare(`
      SELECT
        id,
        vk_post_id,
        item_number,
        photo_attachment,
        photo_owner_id,
        photo_id,
        album_id,
        original_price,
        discount_price,
        photo_text
      FROM post_items
      WHERE vk_post_id IN (${placeholders})
      ORDER BY vk_post_id ASC, item_number ASC
    `).all(...vkPostIds)
    : [];
  const usedItems = vkPostIds.length > 0
    ? db.prepare(`
      SELECT
        id,
        photo_attachment,
        photo_id,
        vk_post_id,
        used_at,
        state
      FROM used_items
      WHERE vk_post_id IN (${placeholders})
      ORDER BY vk_post_id ASC, id ASC
    `).all(...vkPostIds)
    : [];
  const goldBlockNumbers = [...new Set(scheduledPosts
    .map((post) => Number(post.gold_block_number))
    .filter(Boolean))];
  const goldPlaceholders = goldBlockNumbers.map(() => '?').join(',');
  const goldBlocks = goldBlockNumbers.length > 0
    ? db.prepare(`
      SELECT
        block_number,
        gold_position,
        created_at
      FROM roulette_gold_blocks
      WHERE block_number IN (${goldPlaceholders})
      ORDER BY block_number ASC
    `).all(...goldBlockNumbers)
    : [];

  const exportState = {
    schema: 'discount-roulette.queue-state',
    version: 1,
    exported_at: Math.floor(Date.now() / 1000),
    source_db: DB_PATH,
    expected_vk_post_ids: vkPostIds,
    next_roulette_sequence_number: getNextRouletteSequenceNumber(),
    scheduled_posts: scheduledPosts,
    post_items: postItems,
    used_items: usedItems,
    roulette_gold_blocks: goldBlocks,
  };

  validateQueueStateExport(exportState);
  return exportState;
}

function importQueueState(queueState) {
  validateQueueStateExport(queueState);

  const insertPost = db.prepare(`
    INSERT INTO scheduled_posts (
      vk_post_id,
      publish_date,
      publish_date_text,
      delete_after,
      status,
      created_at,
      reservations_checked_at,
      variant,
      discount_percent,
      card_attachment,
      roulette_sequence_number,
      gold_block_number,
      gold_position,
      product_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO post_items (
      vk_post_id,
      item_number,
      photo_attachment,
      photo_owner_id,
      photo_id,
      album_id,
      original_price,
      discount_price,
      photo_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUsedItem = db.prepare(`
    INSERT INTO used_items (
      photo_attachment,
      photo_id,
      vk_post_id,
      used_at,
      state
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(photo_attachment) DO NOTHING
  `);
  const insertGoldBlock = db.prepare(`
    INSERT INTO roulette_gold_blocks (
      block_number,
      gold_position,
      created_at
    ) VALUES (?, ?, ?)
    ON CONFLICT(block_number) DO NOTHING
  `);
  const getExistingPost = db.prepare('SELECT id FROM scheduled_posts WHERE vk_post_id = ?');
  const getExistingItem = db.prepare('SELECT id FROM post_items WHERE vk_post_id = ? AND item_number = ?');
  const getExistingGoldBlock = db.prepare('SELECT gold_position FROM roulette_gold_blocks WHERE block_number = ?');

  const summary = {
    scheduledPostsInserted: 0,
    scheduledPostsSkipped: 0,
    postItemsInserted: 0,
    postItemsSkipped: 0,
    usedItemsInserted: 0,
    usedItemsSkipped: 0,
    goldBlocksInserted: 0,
    goldBlocksSkipped: 0,
  };

  const transaction = db.transaction(() => {
    queueState.roulette_gold_blocks.forEach((block) => {
      const blockNumber = Number(block.block_number);
      const existing = getExistingGoldBlock.get(blockNumber);

      if (existing) {
        if (Number(existing.gold_position) !== Number(block.gold_position)) {
          throw new Error(`Existing gold block ${blockNumber} has different gold_position`);
        }

        summary.goldBlocksSkipped += 1;
        return;
      }

      const result = insertGoldBlock.run(
        blockNumber,
        Number(block.gold_position),
        Number(block.created_at || Math.floor(Date.now() / 1000)),
      );
      summary.goldBlocksInserted += result.changes;
    });

    queueState.scheduled_posts.forEach((rawPost) => {
      const post = normalizeExportedScheduledPost(rawPost);

      if (getExistingPost.get(post.vk_post_id)) {
        summary.scheduledPostsSkipped += 1;
      } else {
        insertPost.run(
          post.vk_post_id,
          post.publish_date,
          post.publish_date_text,
          post.delete_after,
          post.status,
          post.created_at,
          post.reservations_checked_at,
          post.variant,
          post.discount_percent,
          post.card_attachment,
          post.roulette_sequence_number,
          post.gold_block_number,
          post.gold_position,
          post.product_fingerprint,
        );
        summary.scheduledPostsInserted += 1;
      }
    });

    queueState.post_items.forEach((item) => {
      const vkPostId = Number(item.vk_post_id);
      const itemNumber = Number(item.item_number);

      if (getExistingItem.get(vkPostId, itemNumber)) {
        summary.postItemsSkipped += 1;
        return;
      }

      insertItem.run(
        vkPostId,
        itemNumber,
        item.photo_attachment,
        item.photo_owner_id,
        item.photo_id,
        item.album_id,
        item.original_price,
        item.discount_price,
        item.photo_text || '',
      );
      summary.postItemsInserted += 1;
    });

    queueState.used_items.forEach((item) => {
      const result = insertUsedItem.run(
        item.photo_attachment,
        item.photo_id,
        item.vk_post_id,
        item.used_at,
        item.state || 'scheduled',
      );

      if (result.changes > 0) {
        summary.usedItemsInserted += 1;
      } else {
        summary.usedItemsSkipped += 1;
      }
    });
  });

  transaction();

  return {
    ...summary,
    nextRouletteSequenceNumber: getNextRouletteSequenceNumber(),
    futureScheduledPosts: listFutureScheduledPosts().length,
  };
}

function listScheduledPosts(limit = 20) {
  return db.prepare(`
    SELECT
      scheduled_posts.id,
      scheduled_posts.vk_post_id,
      scheduled_posts.publish_date,
      scheduled_posts.publish_date_text,
      scheduled_posts.delete_after,
      scheduled_posts.status,
      scheduled_posts.created_at,
      scheduled_posts.variant,
      scheduled_posts.discount_percent,
      scheduled_posts.card_attachment,
      scheduled_posts.roulette_sequence_number,
      scheduled_posts.gold_block_number,
      scheduled_posts.gold_position,
      scheduled_posts.product_fingerprint,
      COUNT(post_items.id) AS items_count
    FROM scheduled_posts
    LEFT JOIN post_items ON post_items.vk_post_id = scheduled_posts.vk_post_id
    GROUP BY scheduled_posts.id
    ORDER BY scheduled_posts.id DESC
    LIMIT ?
  `).all(limit);
}

function getScheduledPost(vkPostId) {
  return db.prepare(`
    SELECT
      id,
      vk_post_id,
      publish_date,
      publish_date_text,
      delete_after,
      status,
      created_at,
      reservations_checked_at,
      variant,
      discount_percent,
      card_attachment,
      roulette_sequence_number,
      gold_block_number,
      gold_position,
      product_fingerprint
    FROM scheduled_posts
    WHERE vk_post_id = ?
  `).get(vkPostId);
}

function getLatestScheduledPost() {
  return db.prepare(`
    SELECT
      id,
      vk_post_id,
      publish_date,
      publish_date_text,
      delete_after,
      status,
      created_at,
      reservations_checked_at,
      variant,
      discount_percent,
      card_attachment,
      roulette_sequence_number,
      gold_block_number,
      gold_position,
      product_fingerprint
    FROM scheduled_posts
    WHERE status = 'scheduled'
    ORDER BY publish_date DESC, id DESC
    LIMIT 1
  `).get();
}

function listPostsForReservationFix() {
  const now = Math.floor(Date.now() / 1000);

  return db.prepare(`
    SELECT
      id,
      vk_post_id,
      publish_date,
      publish_date_text,
      delete_after,
      status,
      created_at,
      reservations_checked_at,
      variant,
      discount_percent,
      card_attachment,
      roulette_sequence_number,
      gold_block_number,
      gold_position,
      product_fingerprint
    FROM scheduled_posts
    WHERE status IN ('scheduled', 'published')
      AND reservations_checked_at IS NULL
      AND publish_date + 24 * 60 * 60 <= ?
    ORDER BY publish_date ASC, id ASC
  `).all(now);
}

function listCheckedReservationPosts() {
  return db.prepare(`
    SELECT
      id,
      vk_post_id,
      publish_date,
      publish_date_text,
      delete_after,
      status,
      created_at,
      reservations_checked_at,
      variant,
      discount_percent,
      card_attachment,
      roulette_sequence_number,
      gold_block_number,
      gold_position,
      product_fingerprint
    FROM scheduled_posts
    WHERE reservations_checked_at IS NOT NULL
    ORDER BY publish_date ASC, id ASC
  `).all();
}

function listFutureScheduledPosts(now = Math.floor(Date.now() / 1000)) {
  return db.prepare(`
    SELECT
      id,
      vk_post_id,
      publish_date,
      publish_date_text,
      delete_after,
      status,
      created_at,
      reservations_checked_at,
      variant,
      discount_percent,
      card_attachment,
      roulette_sequence_number,
      gold_block_number,
      gold_position,
      product_fingerprint
    FROM scheduled_posts
    WHERE status = 'scheduled'
      AND publish_date > ?
    ORDER BY publish_date ASC, id ASC
  `).all(now);
}

function listPostsForReservationFixByIds(vkPostIds) {
  if (!Array.isArray(vkPostIds) || vkPostIds.length === 0) {
    return [];
  }

  const placeholders = vkPostIds.map(() => '?').join(',');

  return db.prepare(`
    SELECT
      id,
      vk_post_id,
      publish_date,
      publish_date_text,
      delete_after,
      status,
      created_at,
      reservations_checked_at,
      variant,
      discount_percent,
      card_attachment,
      roulette_sequence_number,
      gold_block_number,
      gold_position,
      product_fingerprint
    FROM scheduled_posts
    WHERE status IN ('scheduled', 'published')
      AND vk_post_id IN (${placeholders})
    ORDER BY publish_date DESC, id DESC
  `).all(...vkPostIds);
}

function markReservationsChecked(vkPostId, checkedAt = Math.floor(Date.now() / 1000)) {
  db.prepare(`
    UPDATE scheduled_posts
    SET reservations_checked_at = ?
    WHERE vk_post_id = ?
  `).run(checkedAt, vkPostId);
}

function reopenReservationsChecked(vkPostIds) {
  if (!Array.isArray(vkPostIds) || vkPostIds.length === 0) {
    return {
      updated: 0,
    };
  }

  const update = db.prepare(`
    UPDATE scheduled_posts
    SET reservations_checked_at = NULL
    WHERE vk_post_id = ?
      AND reservations_checked_at IS NOT NULL
  `);
  const transaction = db.transaction(() => vkPostIds.reduce((updated, vkPostId) => (
    updated + update.run(vkPostId).changes
  ), 0));

  return {
    updated: transaction(),
  };
}

function markScheduledPostPublished(vkPostId, publishDate = null) {
  db.prepare(`
    UPDATE scheduled_posts
    SET
      status = 'published',
      publish_date = COALESCE(?, publish_date),
      publish_date_text = COALESCE(?, publish_date_text),
      delete_after = COALESCE(?, delete_after)
    WHERE vk_post_id = ?
  `).run(
    publishDate,
    publishDate ? new Date(publishDate * 1000).toLocaleString('ru-RU', {
      dateStyle: 'short',
      timeStyle: 'short',
    }) : null,
    publishDate ? publishDate + 24 * 60 * 60 : null,
    vkPostId,
  );
}

function getNextRouletteSequenceNumber() {
  const row = db.prepare(`
    SELECT COALESCE(MAX(roulette_sequence_number), 0) + 1 AS next_sequence
    FROM scheduled_posts
    WHERE roulette_sequence_number IS NOT NULL
  `).get();

  return Number(row.next_sequence || 1);
}

function getScheduledPostByProductFingerprint(productFingerprint) {
  if (!productFingerprint) {
    return null;
  }

  return db.prepare(`
    SELECT
      id,
      vk_post_id,
      publish_date,
      publish_date_text,
      status,
      variant,
      roulette_sequence_number,
      product_fingerprint
    FROM scheduled_posts
    WHERE product_fingerprint = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(productFingerprint) || null;
}

function getOrCreateGoldBlock(blockNumber, createGoldPosition) {
  const existing = getGoldBlock(blockNumber);

  if (existing) {
    return {
      blockNumber: Number(existing.block_number),
      goldPosition: Number(existing.gold_position),
      created: false,
    };
  }

  const goldPosition = Number(createGoldPosition());

  db.prepare(`
    INSERT INTO roulette_gold_blocks (
      block_number,
      gold_position,
      created_at
    ) VALUES (?, ?, ?)
  `).run(blockNumber, goldPosition, Math.floor(Date.now() / 1000));

  return {
    blockNumber: Number(blockNumber),
    goldPosition,
    created: true,
  };
}

function getGoldBlock(blockNumber) {
  return db.prepare(`
    SELECT
      block_number,
      gold_position,
      created_at
    FROM roulette_gold_blocks
    WHERE block_number = ?
  `).get(blockNumber);
}

function recordVkApiUsage({
  operation,
  method,
  tokenType,
  success,
  vkErrorCode = null,
  errorKind = null,
  timestamp = Math.floor(Date.now() / 1000),
}) {
  db.prepare(`
    INSERT INTO vk_api_usage (
      timestamp,
      operation,
      method,
      token_type,
      success,
      vk_error_code,
      error_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    timestamp,
    operation,
    method,
    tokenType,
    success ? 1 : 0,
    vkErrorCode,
    errorKind,
  );
}

function getApiUsageRows(startTimestamp, endTimestamp) {
  return db.prepare(`
    SELECT
      operation,
      method,
      token_type,
      success,
      COUNT(*) AS count
    FROM vk_api_usage
    WHERE timestamp >= ?
      AND timestamp < ?
    GROUP BY operation, method, token_type, success
    ORDER BY operation, method, token_type, success DESC
  `).all(startTimestamp, endTimestamp);
}

function getApiUsageTotal(startTimestamp, endTimestamp) {
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN token_type = 'service' THEN 1 ELSE 0 END) AS service,
      SUM(CASE WHEN token_type = 'group' THEN 1 ELSE 0 END) AS "group",
      COUNT(DISTINCT date(timestamp, 'unixepoch', 'localtime')) AS days
    FROM vk_api_usage
    WHERE timestamp >= ?
      AND timestamp < ?
  `).get(startTimestamp, endTimestamp);
}

function getPostItems(vkPostId) {
  return db.prepare(`
    SELECT
      item_number,
      photo_attachment,
      photo_owner_id,
      photo_id,
      album_id,
      original_price,
      discount_price,
      photo_text
    FROM post_items
    WHERE vk_post_id = ?
    ORDER BY item_number ASC
  `).all(vkPostId);
}

function replacePostItems(vkPostId, items) {
  const deleteItems = db.prepare('DELETE FROM post_items WHERE vk_post_id = ?');
  const insertItem = db.prepare(`
    INSERT INTO post_items (
      vk_post_id,
      item_number,
      photo_attachment,
      photo_owner_id,
      photo_id,
      album_id,
      original_price,
      discount_price,
      photo_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    deleteItems.run(vkPostId);

    items.forEach((item, index) => {
      insertItem.run(
        vkPostId,
        index + 1,
        item.photoAttachment,
        item.photoOwnerId,
        item.photoId,
        item.albumId,
        item.originalPrice,
        item.discountPrice,
        item.photoText,
      );
    });
  });

  transaction();
}

function getUsedPhotoAttachments() {
  return db.prepare(`
    SELECT photo_attachment
    FROM used_items
  `).all().map((row) => row.photo_attachment);
}

function getUsedPhotoHistory() {
  return db.prepare(`
    SELECT
      photo_attachment,
      used_at,
      state
    FROM used_items
    WHERE photo_attachment IS NOT NULL
  `).all();
}

function markPostItemsState(vkPostId, state, usedAt = Math.floor(Date.now() / 1000)) {
  const items = getPostItems(vkPostId).map((item) => ({
    photoAttachment: item.photo_attachment,
    photoId: item.photo_id,
  }));

  insertUsedItems(vkPostId, items, usedAt, state);
}

const markScheduledPostDeletedTransaction = db.transaction((vkPostId) => {
  const post = getScheduledPost(vkPostId);

  if (!post) {
    return {
      updated: false,
      reason: 'not_found',
    };
  }

  db.prepare(`
    UPDATE scheduled_posts
    SET status = 'deleted'
    WHERE vk_post_id = ?
  `).run(vkPostId);

  return {
    updated: true,
  };
});

function markScheduledPostDeleted(vkPostId) {
  return markScheduledPostDeletedTransaction(vkPostId);
}

const resetTestPostsTransaction = db.transaction(() => {
  const posts = db.prepare(`
    SELECT vk_post_id
    FROM scheduled_posts
    WHERE status = 'deleted'
  `).all();
  const deletePostItems = db.prepare('DELETE FROM post_items WHERE vk_post_id = ?');
  const deleteUsedItems = db.prepare('DELETE FROM used_items WHERE vk_post_id = ?');
  const deleteScheduledPost = db.prepare('DELETE FROM scheduled_posts WHERE vk_post_id = ?');

  posts.forEach((post) => {
    deletePostItems.run(post.vk_post_id);
    deleteUsedItems.run(post.vk_post_id);
    deleteScheduledPost.run(post.vk_post_id);
  });

  return {
    deletedPosts: posts.map((post) => post.vk_post_id),
  };
});

function resetTestPosts() {
  return resetTestPostsTransaction();
}

function getUsedItemsSummary() {
  const rows = db.prepare(`
    SELECT
      state,
      COUNT(*) AS count
    FROM used_items
    GROUP BY state
  `).all();

  return rows.reduce((summary, row) => {
    summary[row.state || 'scheduled'] = row.count;
    return summary;
  }, {});
}

function getReservationByCommentId(vkPostId, commentId) {
  return db.prepare(`
    SELECT
      id,
      vk_post_id,
      comment_id,
      user_id,
      user_name,
      display_name,
      item_number,
      photo_attachment,
      discount_price,
      status,
      raw_comment,
      created_at,
      fixed_at,
      reply_sent_at,
      photo_comment_status,
      photo_comment_id,
      photo_comment_sent_at,
      photo_comment_last_error,
      photo_comment_guid
    FROM reservations
    WHERE vk_post_id = ? AND comment_id = ?
  `).get(vkPostId, commentId);
}

function getReservationByCommentItem(vkPostId, commentId, itemNumber) {
  if (itemNumber === null || itemNumber === undefined) {
    return db.prepare(`
      SELECT
        id,
        vk_post_id,
        comment_id,
        user_id,
        user_name,
        display_name,
        item_number,
        photo_attachment,
        discount_price,
        status,
        raw_comment,
        created_at,
        fixed_at,
        reply_sent_at,
        photo_comment_status,
        photo_comment_id,
        photo_comment_sent_at,
        photo_comment_last_error,
        photo_comment_guid
      FROM reservations
      WHERE vk_post_id = ?
        AND comment_id = ?
        AND item_number IS NULL
      LIMIT 1
    `).get(vkPostId, commentId);
  }

  return db.prepare(`
    SELECT
      id,
      vk_post_id,
      comment_id,
      user_id,
      user_name,
      display_name,
      item_number,
      photo_attachment,
      discount_price,
      status,
      raw_comment,
      created_at,
      fixed_at,
      reply_sent_at,
      photo_comment_status,
      photo_comment_id,
      photo_comment_sent_at,
      photo_comment_last_error,
      photo_comment_guid
    FROM reservations
    WHERE vk_post_id = ?
      AND comment_id = ?
      AND item_number = ?
    LIMIT 1
  `).get(vkPostId, commentId, itemNumber);
}

function saveReservation(reservation) {
  const existing = getReservationByCommentItem(
    reservation.vkPostId,
    reservation.commentId,
    reservation.itemNumber,
  );

  if (existing) {
    return {
      saved: false,
      reason: 'duplicate',
    };
  }

  const result = db.prepare(`
    INSERT INTO reservations (
      vk_post_id,
      comment_id,
      user_id,
      user_name,
      display_name,
      item_number,
      photo_attachment,
      discount_price,
      status,
      raw_comment,
      created_at,
      fixed_at,
      reply_sent_at,
      photo_comment_status,
      photo_comment_id,
      photo_comment_sent_at,
      photo_comment_last_error,
      photo_comment_guid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reservation.vkPostId,
    reservation.commentId,
    reservation.userId,
    reservation.userName,
    reservation.displayName,
    reservation.itemNumber,
    reservation.photoAttachment,
    reservation.discountPrice,
    reservation.status,
    reservation.rawComment,
    reservation.createdAt,
    reservation.fixedAt,
    reservation.replySentAt,
    reservation.photoCommentStatus || null,
    reservation.photoCommentId || null,
    reservation.photoCommentSentAt || null,
    reservation.photoCommentLastError || null,
    reservation.photoCommentGuid || null,
  );

  return {
    saved: true,
    id: Number(result.lastInsertRowid || 0),
  };
}

function updateReservationResolved(reservation) {
  const sql = reservation.id ? `
    UPDATE reservations
    SET
      item_number = ?,
      photo_attachment = ?,
      discount_price = ?,
      status = 'confirmed',
      raw_comment = ?,
      fixed_at = ?,
      user_name = ?,
      display_name = ?,
      photo_comment_status = COALESCE(photo_comment_status, 'pending')
    WHERE id = ?
  ` : `
    UPDATE reservations
    SET
      item_number = ?,
      photo_attachment = ?,
      discount_price = ?,
      status = 'confirmed',
      raw_comment = ?,
      fixed_at = ?,
      user_name = ?,
      display_name = ?,
      photo_comment_status = COALESCE(photo_comment_status, 'pending')
    WHERE vk_post_id = ? AND comment_id = ? AND item_number = ?
  `;
  const params = reservation.id ? [
    reservation.itemNumber,
    reservation.photoAttachment,
    reservation.discountPrice,
    reservation.rawComment,
    reservation.fixedAt,
    reservation.userName,
    reservation.displayName,
    reservation.id,
  ] : [
    reservation.itemNumber,
    reservation.photoAttachment,
    reservation.discountPrice,
    reservation.rawComment,
    reservation.fixedAt,
    reservation.userName,
    reservation.displayName,
    reservation.vkPostId,
    reservation.commentId,
    reservation.itemNumber,
  ];

  db.prepare(sql).run(...params);
}

function updateReservationUnresolvedComment({ vkPostId, commentId, rawComment, replySentAt }) {
  db.prepare(`
    UPDATE reservations
    SET
      raw_comment = ?,
      reply_sent_at = COALESCE(reply_sent_at, ?)
    WHERE vk_post_id = ? AND comment_id = ?
  `).run(rawComment, replySentAt, vkPostId, commentId);
}

function listReservations(limit = 100) {
  return db.prepare(`
    SELECT
      vk_post_id,
      item_number,
      user_name,
      display_name,
      discount_price,
      status,
      raw_comment,
      photo_comment_status,
      photo_comment_id,
      photo_comment_sent_at,
      photo_comment_last_error,
      photo_comment_guid
    FROM reservations
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

function listPendingPhotoCommentReservations(limit = 100) {
  return db.prepare(`
    SELECT
      reservations.id,
      reservations.vk_post_id,
      reservations.comment_id,
      reservations.user_id,
      reservations.user_name,
      reservations.display_name,
      reservations.item_number,
      reservations.photo_attachment,
      reservations.discount_price,
      reservations.status,
      reservations.raw_comment,
      reservations.created_at,
      reservations.fixed_at,
      reservations.photo_comment_status,
      reservations.photo_comment_id,
      reservations.photo_comment_sent_at,
      reservations.photo_comment_last_error,
      reservations.photo_comment_guid,
      post_items.photo_owner_id,
      post_items.photo_id
    FROM reservations
    JOIN post_items
      ON post_items.vk_post_id = reservations.vk_post_id
      AND post_items.item_number = reservations.item_number
    WHERE reservations.status = 'confirmed'
      AND reservations.photo_comment_status IN ('pending', 'failed_retryable')
    ORDER BY reservations.id ASC
    LIMIT ?
  `).all(limit);
}

function ensureReservationPhotoCommentGuid(reservationId, guid) {
  db.prepare(`
    UPDATE reservations
    SET photo_comment_guid = COALESCE(photo_comment_guid, ?)
    WHERE id = ?
  `).run(guid, reservationId);

  return db.prepare(`
    SELECT
      id,
      photo_comment_guid
    FROM reservations
    WHERE id = ?
  `).get(reservationId);
}

function markReservationPhotoCommentSent(reservationId, commentId, sentAt = Math.floor(Date.now() / 1000)) {
  const result = db.prepare(`
    UPDATE reservations
    SET
      photo_comment_status = 'sent',
      photo_comment_id = ?,
      photo_comment_sent_at = ?,
      photo_comment_last_error = NULL
    WHERE id = ?
  `).run(commentId, sentAt, reservationId);
  return { updated: result.changes === 1 };
}

function markReservationPhotoCommentFailed(reservationId, errorMessage) {
  const result = db.prepare(`
    UPDATE reservations
    SET
      photo_comment_status = 'failed_retryable',
      photo_comment_last_error = ?
    WHERE id = ?
  `).run(String(errorMessage || '').slice(0, 1000), reservationId);
  return { updated: result.changes === 1 };
}

function listBackfillablePhotoCommentReservations(sinceTimestamp) {
  return db.prepare(`
    SELECT
      id,
      vk_post_id,
      comment_id,
      user_id,
      user_name,
      display_name,
      item_number,
      photo_attachment,
      discount_price,
      status,
      raw_comment,
      created_at,
      fixed_at,
      photo_comment_status
    FROM reservations
    WHERE status = 'confirmed'
      AND photo_comment_status IS NULL
      AND created_at >= ?
    ORDER BY id ASC
  `).all(sinceTimestamp);
}

function backfillPhotoCommentPending(sinceTimestamp) {
  const reservations = listBackfillablePhotoCommentReservations(sinceTimestamp);
  const transaction = db.transaction(() => {
    const update = db.prepare(`
      UPDATE reservations
      SET photo_comment_status = 'pending'
      WHERE id = ?
        AND photo_comment_status IS NULL
    `);

    reservations.forEach((reservation) => {
      update.run(reservation.id);
    });
  });

  transaction();

  return {
    updated: reservations.length,
    reservations,
  };
}

module.exports = {
  DB_PATH,
  saveScheduledPost,
  importPublishedPost,
  getQueueStateExport,
  importQueueState,
  validateQueueStateExport,
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
  getUsedPhotoAttachments,
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
};
