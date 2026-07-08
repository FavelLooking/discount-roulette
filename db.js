const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'roulette.sqlite');

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
      created_at INTEGER
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
      reply_sent_at INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_post_comment
      ON reservations(vk_post_id, comment_id);

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
  `);

  const reservationColumns = db.prepare('PRAGMA table_info(reservations)').all();
  const hasReplySentAt = reservationColumns.some((column) => column.name === 'reply_sent_at');
  const hasDisplayName = reservationColumns.some((column) => column.name === 'display_name');
  const usedItemColumns = db.prepare('PRAGMA table_info(used_items)').all();
  const hasUsedItemState = usedItemColumns.some((column) => column.name === 'state');

  if (!hasReplySentAt) {
    db.exec('ALTER TABLE reservations ADD COLUMN reply_sent_at INTEGER');
  }

  if (!hasDisplayName) {
    db.exec('ALTER TABLE reservations ADD COLUMN display_name TEXT');
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

function saveScheduledPost({ vkPostId, publishDate, publishDateText, items }) {
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
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
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

function importPublishedPost({ vkPostId, publishDate, publishDateText, items }) {
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
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
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
      created_at
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
      created_at
    FROM scheduled_posts
    WHERE status = 'scheduled'
    ORDER BY publish_date DESC, id DESC
    LIMIT 1
  `).get();
}

function listPostsForReservationFix() {
  return db.prepare(`
    SELECT
      id,
      vk_post_id,
      publish_date,
      publish_date_text,
      delete_after,
      status,
      created_at
    FROM scheduled_posts
    WHERE status IN ('scheduled', 'published')
    ORDER BY publish_date ASC, id ASC
  `).all();
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
      created_at
    FROM scheduled_posts
    WHERE status IN ('scheduled', 'published')
      AND vk_post_id IN (${placeholders})
    ORDER BY publish_date DESC, id DESC
  `).all(...vkPostIds);
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
      reply_sent_at
    FROM reservations
    WHERE vk_post_id = ? AND comment_id = ?
  `).get(vkPostId, commentId);
}

function saveReservation(reservation) {
  const existing = getReservationByCommentId(reservation.vkPostId, reservation.commentId);

  if (existing) {
    return {
      saved: false,
      reason: 'duplicate',
    };
  }

  db.prepare(`
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
      reply_sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  );

  return {
    saved: true,
  };
}

function updateReservationResolved(reservation) {
  db.prepare(`
    UPDATE reservations
    SET
      item_number = ?,
      photo_attachment = ?,
      discount_price = ?,
      status = 'confirmed',
      raw_comment = ?,
      fixed_at = ?
    WHERE vk_post_id = ? AND comment_id = ?
  `).run(
    reservation.itemNumber,
    reservation.photoAttachment,
    reservation.discountPrice,
    reservation.rawComment,
    reservation.fixedAt,
    reservation.vkPostId,
    reservation.commentId,
  );
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
      raw_comment
    FROM reservations
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

module.exports = {
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
  getUsedPhotoAttachments,
  getUsedPhotoHistory,
  markPostItemsState,
  markScheduledPostDeleted,
  resetTestPosts,
  getUsedItemsSummary,
  getReservationByCommentId,
  saveReservation,
  updateReservationResolved,
  updateReservationUnresolvedComment,
  listReservations,
};
