'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const config = require('./config');

const API_BASE = 'https://api.modrinth.com/v2';
// Modrinth asks for a unique User-Agent. Add a contact (Discord/email/GitHub) here.
const USER_AGENT = 'minecraft-community-bot/1.0.0 (Discord update announcer)';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes, well within Modrinth's rate limits
const MAX_ANNOUNCEMENTS_PER_POLL = 5; // safety cap if many versions land while offline
const STATE_FILE = path.join(config.dataDir, 'modrinth-state.json');

const RELEASE_TYPES = {
  release: { label: 'Release', emoji: '🟢', color: 0x1bd96a },
  beta: { label: 'Beta', emoji: '🟠', color: 0xffa347 },
  alpha: { label: 'Alpha', emoji: '🔴', color: 0xff496e },
};

// ---------- State (last announced version ID per project) ----------

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[modrinth] Could not read state file, starting fresh:', err.message);
    return {};
  }
}

async function saveState(state) {
  await fs.mkdir(config.dataDir, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state), 'utf8');
  await fs.rename(tmp, STATE_FILE); // atomic replace, no half-written files
}

// ---------- Modrinth API ----------

async function modrinthGet(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Modrinth ${endpoint} responded ${res.status} ${res.statusText}`);
  return res.json();
}

// ---------- Embed ----------

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function summarizeList(items, limit = 8) {
  if (!items?.length) return 'N/A';
  const shown = items.slice(0, limit).join(', ');
  return items.length > limit ? `${shown} +${items.length - limit} more` : shown;
}

function buildAnnouncement(project, version) {
  const type = RELEASE_TYPES[version.version_type] ?? RELEASE_TYPES.release;
  const url = `https://modrinth.com/${project.project_type}/${project.slug}/version/${encodeURIComponent(
    version.version_number,
  )}`;

  const embed = new EmbedBuilder()
    .setColor(type.color)
    .setTitle(`🚀 New update: ${project.title}`)
    .setURL(url)
    .addFields(
      { name: 'Project Name', value: project.title, inline: true },
      { name: 'Version Number', value: `\`${version.version_number}\``, inline: true },
      { name: 'Release Type', value: `${type.emoji} ${type.label}`, inline: true },
      { name: 'Minecraft Versions', value: truncate(summarizeList(version.game_versions), 1024), inline: true },
      { name: 'Loaders', value: truncate(summarizeList(version.loaders), 1024), inline: true },
    )
    .setFooter({ text: 'Modrinth' })
    .setTimestamp(new Date(version.date_published));

  if (project.icon_url) embed.setThumbnail(project.icon_url);
  if (version.name && version.name !== version.version_number) {
    embed.setDescription(truncate(`**${version.name}**`, 256));
  }
  if (version.changelog?.trim()) {
    embed.addFields({ name: 'Changelog', value: truncate(version.changelog.trim(), 1000) });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('View on Modrinth').setStyle(ButtonStyle.Link).setURL(url),
  );

  return { embeds: [embed], components: [row] };
}

// ---------- Poll logic ----------

async function getAnnouncementChannel(client) {
  const channel = await client.channels.fetch(config.announcementChannelId);
  if (!channel?.isTextBased() || typeof channel.send !== 'function') {
    throw new Error(`ANNOUNCEMENT_CHANNEL_ID ${config.announcementChannelId} is not a sendable text channel`);
  }
  return channel;
}

async function checkProject(client, projectRef, state) {
  // projectRef may be an ID or a slug; the resolved project.id is what we key state on.
  const project = await modrinthGet(`/project/${encodeURIComponent(projectRef)}`);
  const versions = await modrinthGet(`/project/${encodeURIComponent(project.id)}/version`);

  if (!Array.isArray(versions) || versions.length === 0) return;

  // Newest first (the API already does this; sorting is a cheap safeguard).
  versions.sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
  const latest = versions[0];
  const lastVersionId = state.projects[project.id];

  // First time we see this project: remember the current latest silently so we
  // don't spam old releases. This also applies to projects added to the list later.
  if (!lastVersionId) {
    state.projects[project.id] = latest.id;
    await saveState(state);
    console.log(`[modrinth] Initialised ${project.title} at ${latest.version_number}; no announcement sent.`);
    return;
  }

  if (latest.id === lastVersionId) return;

  const lastIndex = versions.findIndex((v) => v.id === lastVersionId);
  // If the stored version was deleted on Modrinth, only announce the newest one.
  const unseen = lastIndex === -1 ? [latest] : versions.slice(0, lastIndex);
  const toAnnounce = unseen.slice(0, MAX_ANNOUNCEMENTS_PER_POLL).reverse(); // oldest -> newest

  const channel = await getAnnouncementChannel(client);

  for (const version of toAnnounce) {
    await channel.send(buildAnnouncement(project, version));
    // Persist after every successful send so a crash mid-loop never causes duplicates.
    state.projects[project.id] = version.id;
    await saveState(state);
    console.log(`[modrinth] Announced ${project.title} ${version.version_number}`);
  }
}

async function checkForUpdates(client) {
  const state = await loadState();
  state.projects ??= {};

  // One failing project (bad ID, API hiccup) must not block the others.
  for (const projectRef of config.modrinthProjectIds) {
    try {
      await checkProject(client, projectRef, state);
    } catch (err) {
      console.error(`[modrinth] Check failed for "${projectRef}" (will retry next cycle):`, err.message);
    }
  }
}

/** Starts a non-overlapping polling loop. Returns a function that stops it. */
function startModrinthPolling(client) {
  let timer = null;
  let stopped = false;

  const tick = async () => {
    try {
      await checkForUpdates(client);
    } catch (err) {
      console.error('[modrinth] Poll failed (will retry next cycle):', err.message);
    }
    if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
  };

  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

module.exports = { startModrinthPolling };
