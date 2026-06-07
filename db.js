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
  `);

  const reservationColumns = db.prepare('PRAGMA table_info(reservations)').all();
  const hasReplySentAt = reservationColumns.some((column) => column.name === 'reply_sent_at');
  const hasDisplayName = reservationColumns.some((column) => column.name === 'display_name');

  if (!hasReplySentAt) {
    db.exec('ALTER TABLE reservations ADD COLUMN reply_sent_at INTEGER');
  }

  if (!hasDisplayName) {
    db.exec('ALTER TABLE reservations ADD COLUMN display_name TEXT');
  }

  return db;
}

const db = openDb();

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
  getReservationByCommentId,
  saveReservation,
  updateReservationResolved,
  updateReservationUnresolvedComment,
  listReservations,
};
