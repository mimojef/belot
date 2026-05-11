CREATE TABLE IF NOT EXISTS profile_gallery_images (
  image_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  image_url TEXT NOT NULL,
  thumbnail_url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id)
    REFERENCES profiles(profile_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_profile_gallery_images_profile_sort
  ON profile_gallery_images(profile_id, sort_order, created_at);
