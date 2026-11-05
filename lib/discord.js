'use strict';
// Discord Rich Presence (optional; off by default). Uses @xhayper/discord-rpc, which talks to the local
// Discord app over its IPC socket — no native build step.
function createDiscord({ ipcMain, readPrefs }) {
  const { Client: DiscordRPCClient } = require('@xhayper/discord-rpc');
  let discordClient = null;
  let discordConnected = false;
  let discordReconnectTimer = null;
  let discordConnecting = false;
  const discordSessionStart = Math.floor(Date.now() / 1000);
  let lastDiscordActivity = { details: 'Idle', state: 'No project open' };

  function clearDiscordReconnectTimer() {
    if (discordReconnectTimer) {
      clearTimeout(discordReconnectTimer);
      discordReconnectTimer = null;
    }
  }

  function destroyDiscordClient() {
    clearDiscordReconnectTimer();
    discordConnecting = false;
    discordConnected = false;
    if (discordClient) {
      const toDestroy = discordClient;
      discordClient = null;
      try { toDestroy.destroy().catch(() => {}); } catch { /* already gone */ }
    }
  }

  function applyDiscordActivity() {
    if (!discordConnected || !discordClient || !discordClient.user) return;
    const { details, state } = lastDiscordActivity;
    discordClient.user.setActivity({
      details: String(details || 'Idle').slice(0, 128),
      state: state ? String(state).slice(0, 128) : undefined,
      startTimestamp: discordSessionStart,
      largeImageKey: 'nexo_logo',
      largeImageText: 'Nexo Dev',
      instance: false,
    }).then(() => {
      console.log('[discord-rpc] activity sent:', details, '|', state);
    }).catch((err) => console.error('[discord-rpc] setActivity failed:', err.message));
  }

  let discordHasWarnedDisconnected = false;

  function scheduleDiscordReconnect() {
    clearDiscordReconnectTimer();
    discordReconnectTimer = setTimeout(() => {
      discordReconnectTimer = null;
      connectDiscordRpc();
    }, 15000); // Discord not running yet, or a transient drop — try again shortly.
  }

  function connectDiscordRpc() {
    const prefs = readPrefs();
    if (!prefs.discordRpcEnabled || !prefs.discordClientId) return;
    if (discordClient || discordConnecting) return; // already connected or mid-attempt

    discordConnecting = true;
    const client = new DiscordRPCClient({ clientId: prefs.discordClientId });
    discordClient = client;

    client.on('ready', () => {
      discordConnecting = false;
      discordConnected = true;
      discordHasWarnedDisconnected = false; // back up — allow one fresh warning if it drops again
      // Confirms the IPC handshake actually completed and which account it
      // authenticated as — useful for telling "connected but Discord is
      // hiding it" apart from "never connected at all".
      console.log('[discord-rpc] connected as', client.user?.username || '(unknown user)');
      applyDiscordActivity();
    });

    client.on('disconnected', () => {
      discordConnected = false;
      if (discordClient === client) {
        discordClient = null;
        scheduleDiscordReconnect();
      }
    });

    client.login().catch((err) => {
      // Most common cause: Discord desktop isn't running (this needs the
      // desktop app's local IPC socket — Discord in a browser tab can't
      // provide that), or the client ID is wrong/not registered. Quiet retry
      // rather than surfacing a dialog — this is a nice-to-have, not something
      // that should interrupt coding. Log it once per outage, not every retry,
      // so a long coding session without Discord open doesn't spam the console.
      if (!discordHasWarnedDisconnected) {
        console.error('[discord-rpc] connection failed:', err.message, '(will keep retrying quietly)');
        discordHasWarnedDisconnected = true;
      }
      discordConnecting = false;
      if (discordClient === client) {
        discordClient = null;
        scheduleDiscordReconnect();
      }
    });
  }

  function reconnectDiscordRpc() {
    destroyDiscordClient();
    discordHasWarnedDisconnected = false;
    connectDiscordRpc();
  }

  function setDiscordActivity(details, state) {
    lastDiscordActivity = { details: details || 'Idle', state: state || null };
    applyDiscordActivity();
  }

  ipcMain.handle('discord:set-activity', (evt, details, state) => {
    setDiscordActivity(details, state);
    return { ok: true };
  });
  return { connect: connectDiscordRpc, reconnect: reconnectDiscordRpc, destroy: destroyDiscordClient };
}

module.exports = { createDiscord };
