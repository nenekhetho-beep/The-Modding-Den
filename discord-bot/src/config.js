'use strict';

const path = require('node:path');
require('dotenv').config(); // no-op on Railway; loads .env locally

const REQUIRED = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'MODRINTH_PROJECT_ID',
  'ANNOUNCEMENT_CHANNEL_ID',
  'STAFF_ROLE_IDS',
  'CATEGORY_ID',
];

const missing = REQUIRED.filter((key) => !process.env[key]?.trim());
if (missing.length > 0) {
  console.error(`[config] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// "123,456, 789" -> ['123', '456', '789'] (trimmed, de-duplicated, empties dropped)
const staffRoleIds = [
  ...new Set(
    process.env.STAFF_ROLE_IDS.split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  ),
];

// "abc123,my-mod-slug" -> ['abc123', 'my-mod-slug']. Modrinth accepts project IDs or slugs.
const modrinthProjectIds = [
  ...new Set(
    process.env.MODRINTH_PROJECT_ID.split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  ),
];
if (modrinthProjectIds.length === 0) {
  console.error('[config] MODRINTH_PROJECT_ID must contain at least one project ID.');
  process.exit(1);
}

const invalidIds = staffRoleIds.filter((id) => !/^\d{17,20}$/.test(id));
if (staffRoleIds.length === 0 || invalidIds.length > 0) {
  console.error(
    `[config] STAFF_ROLE_IDS must be comma-separated Discord role IDs. Invalid entries: ${
      invalidIds.join(', ') || '(none provided)'
    }`,
  );
  process.exit(1);
}

module.exports = Object.freeze({
  discordToken: process.env.DISCORD_TOKEN.trim(),
  clientId: process.env.CLIENT_ID.trim(),
  modrinthProjectIds,
  announcementChannelId: process.env.ANNOUNCEMENT_CHANNEL_ID.trim(),
  categoryId: process.env.CATEGORY_ID.trim(),
  staffRoleIds,
  // Railway sets RAILWAY_VOLUME_MOUNT_PATH automatically when a Volume is attached.
  dataDir: process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data'),
});
