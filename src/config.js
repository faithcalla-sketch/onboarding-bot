import { config as loadEnv } from 'dotenv';

loadEnv();

function str(name, fallback = '') {
  const raw = process.env[name];
  return raw === undefined || raw === null ? fallback : String(raw).trim();
}

function num(name, fallback) {
  const raw = str(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(name) {
  return str(name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  discord: {
    token: str('DISCORD_TOKEN'),
    clientId: str('DISCORD_CLIENT_ID'),
    guildId: str('DISCORD_GUILD_ID'),
    reviewChannelId: str('REVIEW_CHANNEL_ID'),
    approverIds: list('APPROVER_IDS'),
  },
  trello: {
    key: str('TRELLO_KEY'),
    token: str('TRELLO_TOKEN'),
  },
  ringcentral: {
    serverUrl: str('RINGCENTRAL_SERVER_URL', 'https://platform.ringcentral.com'),
    clientId: str('RINGCENTRAL_CLIENT_ID'),
    clientSecret: str('RINGCENTRAL_CLIENT_SECRET'),
    jwt: str('RINGCENTRAL_JWT'),
    fromNumber: str('RINGCENTRAL_FROM_NUMBER'),
  },
  teamName: str('TEAM_NAME', 'The Onboarding Team'),
  defaultCountryCode: str('DEFAULT_COUNTRY_CODE', '+1'),
  defaultTimezone: str('DEFAULT_TIMEZONE', 'America/New_York'),
  followupHours: num('FOLLOWUP_HOURS', 4),
  dryRun: str('DRY_RUN') === '1' || str('DRY_RUN').toLowerCase() === 'true',
};

config.ringcentral.enabled = Boolean(
  config.ringcentral.clientId &&
    config.ringcentral.clientSecret &&
    config.ringcentral.jwt &&
    config.ringcentral.fromNumber,
);

/**
 * Everything the bot cannot start without. RingCentral is deliberately optional:
 * Discord is the primary channel, SMS is the fallback.
 */
const REQUIRED = [
  ['DISCORD_TOKEN', config.discord.token],
  ['DISCORD_CLIENT_ID', config.discord.clientId],
  ['DISCORD_GUILD_ID', config.discord.guildId],
  ['REVIEW_CHANNEL_ID', config.discord.reviewChannelId],
  ['TRELLO_KEY', config.trello.key],
  ['TRELLO_TOKEN', config.trello.token],
];

export function assertConfig() {
  const missing = REQUIRED.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. Copy .env.example to .env and fill them in.`,
    );
  }
}

export function isApprover(userId) {
  if (!config.discord.approverIds.length) return true;
  return config.discord.approverIds.includes(userId);
}

/**
 * Explicit team membership, used to tell "the client replied" apart from
 * "one of us posted in the channel". Unlike isApprover this never defaults to
 * true, because an empty allowlist must not make everyone look like staff.
 */
export function isTeamMember(userId) {
  return config.discord.approverIds.includes(userId);
}
