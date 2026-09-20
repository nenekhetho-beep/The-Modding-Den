'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const config = require('./config');

const TOPIC_PREFIX = 'ticket-owner'; // channel topic: ticket-owner:<userId>:<type>
const CLOSE_DELAY_MS = 5000;
const CLOSE_BUTTON_ID = 'ticket:close';

const TICKET_TYPES = {
  admin: {
    customId: 'ticket:open:admin',
    label: 'Contact Admin',
    emoji: '📩',
    style: ButtonStyle.Primary,
    channelPrefix: 'admin-ticket',
    title: 'Admin Support Ticket',
    color: 0x5865f2,
    intro: 'Please describe what you need help with. A staff member will be with you shortly.',
  },
  report: {
    customId: 'ticket:open:report',
    label: 'Server Report',
    emoji: '⚠️',
    style: ButtonStyle.Danger,
    channelPrefix: 'report',
    title: 'Server Report',
    color: 0xed4245,
    intro: 'Please include who/what you are reporting, what happened, and any screenshots or evidence.',
  },
};

const TICKET_ACCESS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

const commands = [
  new SlashCommandBuilder()
    .setName('setup-tickets')
    .setDescription('Post the ticket panel (Contact Admin / Server Report) in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild),
];

// ---------- Helpers ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

const ticketTopic = (userId, typeKey) => `${TOPIC_PREFIX}:${userId}:${typeKey}`;

function slugifyUsername(username, fallback) {
  const slug = username
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

// ---------- Panel ----------

async function handleSetup(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply(ephemeral('❌ Only administrators can use this command.'));
  }
  if (!interaction.channel?.isTextBased() || typeof interaction.channel.send !== 'function') {
    return interaction.reply(ephemeral('❌ Run this command in a text channel.'));
  }

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('🎫 Support Center')
    .setDescription(
      [
        '**📩 Contact Admin** — questions, appeals, or anything that needs a staff member.',
        '**⚠️ Server Report** — report a player, bug, or rule violation.',
        '',
        'Click a button below to open a private ticket. Only you and our staff can see it.',
      ].join('\n'),
    );

  const row = new ActionRowBuilder().addComponents(
    ...Object.values(TICKET_TYPES).map((type) =>
      new ButtonBuilder()
        .setCustomId(type.customId)
        .setLabel(type.label)
        .setEmoji(type.emoji)
        .setStyle(type.style),
    ),
  );

  await interaction.channel.send({ embeds: [embed], components: [row] });
  return interaction.reply(ephemeral('✅ Ticket panel deployed.'));
}

// ---------- Open ticket ----------

async function openTicket(interaction, typeKey) {
  const type = TICKET_TYPES[typeKey];
  if (!type) return interaction.reply(ephemeral('❌ Unknown ticket type.'));

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { guild, user, client } = interaction;

  const category = await guild.channels.fetch(config.categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    console.error(`[tickets] CATEGORY_ID ${config.categoryId} is not a category in guild ${guild.id}`);
    return interaction.editReply('❌ Ticket category is misconfigured. Please contact an administrator.');
  }

  // One open ticket per user per type.
  const topic = ticketTopic(user.id, typeKey);
  const existing = guild.channels.cache.find((ch) => ch.parentId === category.id && ch.topic === topic);
  if (existing) {
    return interaction.editReply(`❌ You already have an open ticket: ${existing}`);
  }

  // Ignore role IDs that don't exist in this guild (typos, deleted roles).
  const staffRoleIds = config.staffRoleIds.filter((id) => guild.roles.cache.has(id));
  if (staffRoleIds.length < config.staffRoleIds.length) {
    console.warn('[tickets] Some STAFF_ROLE_IDS were not found in this guild and were skipped.');
  }

  try {
    const channel = await guild.channels.create({
      name: `${type.channelPrefix}-${slugifyUsername(user.username, user.id)}`,
      type: ChannelType.GuildText,
      parent: category.id,
      topic,
      reason: `${type.title} opened by ${user.tag}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, type: OverwriteType.Member, allow: TICKET_ACCESS },
        {
          id: client.user.id,
          type: OverwriteType.Member,
          allow: [...TICKET_ACCESS, PermissionFlagsBits.ManageChannels],
        },
        ...staffRoleIds.map((id) => ({
          id,
          type: OverwriteType.Role,
          allow: [...TICKET_ACCESS, PermissionFlagsBits.ManageMessages],
        })),
      ],
    });

    const embed = new EmbedBuilder()
      .setColor(type.color)
      .setTitle(`${type.emoji} ${type.title}`)
      .setDescription(`Hello ${user}! ${type.intro}`)
      .setFooter({ text: 'Staff or the ticket owner can close this ticket with the button below.' })
      .setTimestamp();

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(CLOSE_BUTTON_ID).setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
    );

    await channel.send({
      content: [`<@${user.id}>`, ...staffRoleIds.map((id) => `<@&${id}>`)].join(' '),
      embeds: [embed],
      components: [closeRow],
      allowedMentions: { users: [user.id], roles: staffRoleIds },
    });

    return interaction.editReply(`✅ Your ticket has been created: ${channel}`);
  } catch (err) {
    console.error('[tickets] Failed to create ticket:', err);
    const hint =
      err.code === 50013
        ? 'The bot is missing permissions (Manage Channels / Manage Roles).'
        : err.code === 30013 || err.code === 50035
          ? 'The ticket category may be full.'
          : 'Please try again later.';
    return interaction.editReply(`❌ Could not create your ticket. ${hint}`);
  }
}

// ---------- Close ticket ----------

async function closeTicket(interaction) {
  const { channel, member, user } = interaction;

  if (channel?.parentId !== config.categoryId || !channel.topic?.startsWith(`${TOPIC_PREFIX}:`)) {
    return interaction.reply(ephemeral('❌ This is not a ticket channel.'));
  }

  const ownerId = channel.topic.split(':')[1];
  const isOwner = user.id === ownerId;
  const isStaff =
    member.roles.cache.some((role) => config.staffRoleIds.includes(role.id)) ||
    interaction.memberPermissions.has(PermissionFlagsBits.Administrator);

  if (!isOwner && !isStaff) {
    return interaction.reply(ephemeral('❌ Only staff or the ticket owner can close this ticket.'));
  }

  await interaction.reply({ content: `🔒 Ticket closed by ${user}. This channel will be deleted in ${CLOSE_DELAY_MS / 1000} seconds…` });
  await sleep(CLOSE_DELAY_MS);
  await channel.delete(`Ticket closed by ${user.tag}`).catch((err) => console.error('[tickets] Delete failed:', err.message));
}

// ---------- Router ----------

async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup-tickets') {
    return handleSetup(interaction);
  }

  if (interaction.isButton()) {
    if (interaction.customId === CLOSE_BUTTON_ID) return closeTicket(interaction);
    if (interaction.customId.startsWith('ticket:open:')) {
      return openTicket(interaction, interaction.customId.split(':')[2]);
    }
  }
  return undefined;
}

module.exports = { commands, handleInteraction };
