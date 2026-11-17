import { ipcMain, IpcMainEvent, safeStorage, session, shell, type WebContents } from "electron";
import { PassThrough } from "node:stream";
import type { Client, Guild, VoiceBasedChannel, VoiceState } from "discord.js";
import type { AudioPlayer, AudioResource, VoiceConnection } from "@discordjs/voice";
import log from "electron-log";
import Integration from "../integration";
import ConfigStore from "../../services/configstore";
import MemoryStore from "../../services/memorystore";
import PlayerStateStore from "../../services/playerstatestore";
import YTMViewManager from "../../services/ytmviewmanager";
import AppWindowManager from "../../services/windowmanager";
import { MemoryStoreSchema } from "~shared/store/schema";
import { PlayerState, VideoState } from "~shared/playerstatestore/types";

const PCM_HIGH_WATER_MARK = 48000 * 2 * 2 * 0.2;
const MIN_MUSIC_BITRATE = 128_000;
const MAX_MUSIC_BITRATE = 384_000;

const OPUS_SET_BITRATE = 4002;
const OPUS_SET_VBR = 4006;
const OPUS_SET_BANDWIDTH = 4008;
const OPUS_SET_COMPLEXITY = 4010;
const OPUS_SET_DTX = 4016;
const OPUS_SET_SIGNAL = 4024;
const OPUS_SET_LSB_DEPTH = 4036;
const OPUS_BANDWIDTH_FULLBAND = 1105;
const OPUS_SIGNAL_MUSIC = 3002;

type MusicEncoder = {
  setBitrate?: (bitrate: number) => void;
  encoder?: {
    encoderCTL?: (ctl: number, value: number) => void;
    applyEncoderCTL?: (ctl: number, value: number) => void;
  };
};

function musicBitrate(channelBitrate: number) {
  const requested = channelBitrate > 0 ? channelBitrate : MIN_MUSIC_BITRATE;
  return Math.min(MAX_MUSIC_BITRATE, Math.max(MIN_MUSIC_BITRATE, requested));
}

function configureMusicEncoder(encoder: MusicEncoder, channelBitrate: number) {
  const target = musicBitrate(channelBitrate);
  const inner = encoder.encoder;
  const ctl = inner?.encoderCTL ?? inner?.applyEncoderCTL;
  let bitrateApplied = false;
  if (ctl && inner) {
    const set = (request: number, value: number) => {
      try {
        ctl.call(inner, request, value);
        return true;
      } catch (error) {
        log.warn("Discord voice encoder setting was rejected", request, error);
        return false;
      }
    };
    bitrateApplied = set(OPUS_SET_BITRATE, target);
    set(OPUS_SET_VBR, 1);
    set(OPUS_SET_BANDWIDTH, OPUS_BANDWIDTH_FULLBAND);
    set(OPUS_SET_COMPLEXITY, 10);
    set(OPUS_SET_DTX, 0);
    set(OPUS_SET_SIGNAL, OPUS_SIGNAL_MUSIC);
    set(OPUS_SET_LSB_DEPTH, 16);
  }

  if (!bitrateApplied) {
    try {
      encoder.setBitrate?.(Math.min(128_000, target));
    } catch (error) {
      log.warn("Discord voice bitrate was not applied", error);
    }
    return Math.min(128_000, target);
  }
  return target;
}

function isSnowflake(value: string) {
  return /^\d{15,25}$/.test(value);
}

function decodeBotClientId(token: string): string | null {
  const part = token.split(".")[0];
  if (!part) return null;
  try {
    const id = Buffer.from(part, "base64").toString("utf8");
    return isSnowflake(id) ? id : null;
  } catch {
    return null;
  }
}

function redact(error: unknown, token: string | null): string {
  let message = error instanceof Error ? error.message : String(error);
  if (token) message = message.split(token).join("bot token");
  if (message.length > 300) message = message.slice(0, 300);
  return message;
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isMissingVoiceState(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const status = "status" in error ? Number(error.status) : NaN;
  if (status === 404) return true;
  const code = "code" in error ? Number(error.code) : NaN;
  return code === 10065;
}

function shouldOutput(state: PlayerState) {
  return state.trackState === VideoState.Playing && !state.muted && !state.adPlaying;
}

function isCaptureHostFrame(url: string) {
  return url.startsWith("ytmd-app://titlebar") || url.includes("/windows/titlebar/");
}

export default class DiscordVoice extends Integration {
  public name = "DiscordVoice";
  public storeEnableProperty: Integration["storeEnableProperty"] = "integrations.discordVoiceEnabled";
  public override dependentStoreProperties: Integration["dependentStoreProperties"] = [
    "integrations.discordVoiceBotToken",
    "integrations.discordVoiceUserId"
  ];
  public override disableFlags = ["disable_discord_voice"];

  private generation = 0;
  private client: Client | null = null;
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer | null = null;
  private resource: AudioResource | null = null;
  private pcmStream: PassThrough | null = null;
  private playbackBitrate = MIN_MUSIC_BITRATE;
  private droppingPcm = false;
  private outputEnabled = false;
  private captureHost: WebContents | null = null;
  private cacheTimer: ReturnType<typeof setInterval> | null = null;
  private onCaptureHostLoaded = () => {
    this.sendToCaptureHost("discordVoice:setOutput", this.outputEnabled);
    this.sendToCaptureHost("discordVoice:setActive", true);
  };
  private stateCallback: ((state: PlayerState) => void) | null = null;
  private viewRecreated: (() => void) | null = null;
  private status = "";
  private detail = "";
  private presenceKey = "";
  private voice: typeof import("@discordjs/voice") | null = null;
  private followedUserId = "";
  private desiredChannelId: string | null = null;
  private followAttempt = 0;
  private followChain: Promise<void> = Promise.resolve();
  private voiceRevision = 0;
  private startupSettled = false;

  private onVoiceState = (previous: VoiceState, next: VoiceState) => {
    if (!this.followedUserId || next.id !== this.followedUserId) return;
    if (previous.channelId === next.channelId) return;
    this.voiceRevision++;
    this.desiredChannelId = next.channelId;
    this.queueFollow(this.generation);
  };

  private onGuildAvailable = (guild: Guild) => {
    if (!this.followedUserId || this.desiredChannelId) return;
    const cached = guild.voiceStates.cache.get(this.followedUserId);
    if (cached?.channelId) {
      this.rememberChannel(cached.channelId);
      return;
    }
    // No cache entry means this payload omitted voice states. A null channel means the user is not here.
    if (cached || !guild.available) return;
    void this.fetchGuildVoiceState(guild, this.voiceRevision);
  };

  private rememberChannel(channelId: string) {
    if (this.desiredChannelId) return;
    this.desiredChannelId = channelId;
    // The initial follow runs once the gateway is ready. A guild that arrives later still needs one.
    if (this.startupSettled) this.queueFollow(this.generation);
  }

  private async fetchGuildVoiceState(guild: Guild, revision: number) {
    const userId = this.followedUserId;
    if (!userId) return;
    try {
      const state = await guild.voiceStates.fetch(userId);
      if (revision !== this.voiceRevision || this.followedUserId !== userId) return;
      if (state.channelId) this.rememberChannel(state.channelId);
    } catch (error) {
      if (isMissingVoiceState(error)) return;
      log.warn("Could not look up your voice channel", redact(error, null));
    }
  }

  private onPcm = (event: IpcMainEvent, payload: Uint8Array) => {
    if (!this.captureHost || event.sender.id !== this.captureHost.id) return;
    if (!this.outputEnabled || !this.pcmStream || this.droppingPcm) return;
    if (!(payload instanceof Uint8Array) || payload.byteLength === 0) return;

    const chunk = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    const queued = this.pcmStream.write(chunk);
    if (!queued) {
      this.droppingPcm = true;
      this.pcmStream.once("drain", () => {
        this.droppingPcm = false;
      });
    }
  };

  private onCaptureError = (event: IpcMainEvent, message: unknown) => {
    if (!this.captureHost || event.sender.id !== this.captureHost.id) return;
    if (typeof message !== "string" || message.length === 0) return;
    this.setStatus(this.outputEnabled ? "live" : this.status || "paused", message.slice(0, 300));
  };

  private onCaptureStarted = (event: IpcMainEvent) => {
    if (!this.captureHost || event.sender.id !== this.captureHost.id) return;
    if (!this.connection) return;
    this.setStatus(this.outputEnabled ? "live" : "paused", "");
  };

  public onSetup() {
    ipcMain.handle("discordVoice:openInvite", async () => {
      const token = await this.readToken();
      if (!token) return "missing";
      const clientId = decodeBotClientId(token);
      if (!clientId) return "invalid";
      // Connect (1 << 20) + Speak (1 << 21). The bot still needs permission to view the channel.
      await shell.openExternal(`https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=3145728&scope=bot`);
      return "opened";
    });
  }

  public async onEnabled() {
    const session = ++this.generation;
    this.outputEnabled = false;
    this.presenceKey = "";
    this.setStatus("connecting", "");

    let token: string | null = null;
    try {
      const configStore = this.getService(ConfigStore);
      const userId = String(configStore.get("integrations.discordVoiceUserId") ?? "").trim();
      if (!this.safeStorageAvailable()) throw new Error("Discord voice needs Windows, macOS, or Linux credential storage, which is unavailable on this machine.");
      if (!configStore.get("integrations.discordVoiceBotToken")) throw new Error("Save a bot token first.");
      token = await this.readToken();
      if (session !== this.generation) return;
      if (!token) throw new Error("The saved bot token could not be read. Paste it again.");
      if (!isSnowflake(userId)) throw new Error("Enter your Discord user ID. Enable Developer Mode, then right-click your name and choose Copy User ID.");
      this.followedUserId = userId;

      const discord = await import("discord.js");
      const voice = await import("@discordjs/voice");
      await import("opusscript");
      await import("libsodium-wrappers");
      await import("@snazzah/davey");
      if (session !== this.generation) return;
      this.voice = voice;

      this.player = voice.createAudioPlayer({
        behaviors: {
          // A file would end after a short gap. This is a live tap, so keep the player open and send silence.
          maxMissedFrames: 1_000_000
        }
      });
      this.openPlaybackResource();
      this.player.on("error", error => {
        log.error("Discord voice player error", redact(error, token));
        this.setStatus("error", redact(error, token));
      });

      ipcMain.on("discordVoice:pcm", this.onPcm);
      ipcMain.on("discordVoice:captureError", this.onCaptureError);
      ipcMain.on("discordVoice:captureStarted", this.onCaptureStarted);

      const clientRef: { current: Client | null } = { current: null };
      const keepUser = (id: string) => id === userId || id === clientRef.current?.user?.id;
      const client = new discord.Client({
        intents: [discord.GatewayIntentBits.Guilds, discord.GatewayIntentBits.GuildVoiceStates],
        // The bot only needs guilds, voice channels, and one user's voice state.
        // Everything else in a GUILD_CREATE payload is dropped instead of cached.
        makeCache: discord.Options.cacheWithLimits({
          MessageManager: 0,
          PresenceManager: 0,
          ReactionManager: 0,
          ReactionUserManager: 0,
          GuildEmojiManager: 0,
          GuildStickerManager: 0,
          GuildBanManager: 0,
          GuildInviteManager: 0,
          GuildScheduledEventManager: 0,
          StageInstanceManager: 0,
          ThreadManager: 0,
          ThreadMemberManager: 0,
          AutoModerationRuleManager: 0,
          EntitlementManager: 0,
          VoiceStateManager: {
            maxSize: 0,
            keepOverLimit: (state: { id: string }) => state.id === userId
          },
          GuildMemberManager: {
            maxSize: 0,
            keepOverLimit: (member: { id: string }) => member.id === clientRef.current?.user?.id
          },
          UserManager: {
            maxSize: 0,
            keepOverLimit: (cachedUser: { id: string }) => keepUser(cachedUser.id)
          }
        })
      });
      clientRef.current = client;
      this.client = client;
      // login() resolves on the gateway READY payload, before guild voice states exist.
      // Initial guilds emit guildAvailable, not guildCreate, and only after that payload.
      client.on("voiceStateUpdate", this.onVoiceState);
      client.on("guildCreate", this.onGuildAvailable);
      client.on("guildAvailable", this.onGuildAvailable);
      await client.login(token);
      if (session !== this.generation) {
        client.destroy();
        return;
      }
      await this.waitForClientReady(client, session);
      if (session !== this.generation) return;

      const playerStateStore = this.getService(PlayerStateStore);
      this.stateCallback = state => this.applyPlayback(state);
      playerStateStore.on("state-changed", this.stateCallback);
      this.applyPlayback(playerStateStore.getState());

      const ytmViewManager = this.getService(YTMViewManager);
      this.viewRecreated = () => {
        this.sendToCaptureHost("discordVoice:recapture");
      };
      ytmViewManager.on("view-recreated", this.viewRecreated);

      this.trimDiscordCache();
      this.cacheTimer = setInterval(() => this.trimDiscordCache(), 60_000);

      this.startupSettled = true;
      this.syncDesiredChannelFromCache();
      this.queueFollow(session);
    } catch (error) {
      if (session !== this.generation) return;
      const message = redact(error, token);
      log.error("Discord voice stream failed", message);
      this.setStatus("error", message);
      this.stopResources();
    }
  }

  public onDisabled() {
    this.generation++;
    this.setStatus("", "");
    this.stopResources();
  }

  private queueFollow(session: number) {
    const attempt = ++this.followAttempt;
    this.followChain = this.followChain
      .then(() => this.followUser(session, attempt))
      .catch(error => {
        if (!this.currentFollow(session, attempt)) return;
        const message = redact(error, null);
        log.error("Discord voice follow failed", message);
        this.leaveVoice();
        this.setStatus("error", message);
      });
  }

  private currentFollow(session: number, attempt: number) {
    return session === this.generation && attempt === this.followAttempt;
  }

  private syncDesiredChannelFromCache() {
    const client = this.client;
    if (!client || !this.followedUserId) {
      this.desiredChannelId = null;
      return;
    }
    for (const guild of client.guilds.cache.values()) {
      const channelId = guild.voiceStates.cache.get(this.followedUserId)?.channelId ?? null;
      if (channelId) {
        this.desiredChannelId = channelId;
        return;
      }
    }
    this.desiredChannelId = null;
  }

  private async resolveDesiredChannel(): Promise<VoiceBasedChannel | null> {
    const channelId = this.desiredChannelId;
    const client = this.client;
    if (!channelId || !client) return null;
    const cached = client.channels.cache.get(channelId);
    if (cached?.isVoiceBased()) return cached;
    try {
      const fetched = await client.channels.fetch(channelId);
      if (fetched?.isVoiceBased()) return fetched;
    } catch (error) {
      log.warn("Could not resolve the voice channel you are in", redact(error, null));
    }
    return null;
  }

  private async locateUserChannel(session: number, attempt: number) {
    const client = this.client;
    const userId = this.followedUserId;
    if (!client || !userId) return;
    const revision = this.voiceRevision;
    this.syncDesiredChannelFromCache();
    if (this.desiredChannelId || revision !== this.voiceRevision) return;

    for (const guild of client.guilds.cache.values()) {
      if (!this.currentFollow(session, attempt) || this.voiceRevision !== revision || this.desiredChannelId) return;
      if (!guild.available) continue;
      try {
        const state = await guild.voiceStates.fetch(userId);
        if (!this.currentFollow(session, attempt) || this.voiceRevision !== revision || this.desiredChannelId) return;
        if (state.channelId) {
          this.desiredChannelId = state.channelId;
          return;
        }
      } catch (error) {
        if (isMissingVoiceState(error)) continue;
        log.warn("Could not look up your voice channel", redact(error, null));
      }
    }
  }

  private waitForClientReady(client: Client, session: number) {
    if (client.isReady() || session !== this.generation) return Promise.resolve();
    return new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.off("clientReady", finish);
        resolve();
      };
      const timer = setTimeout(finish, 20_000);
      client.once("clientReady", finish);
    });
  }

  private async followUser(session: number, attempt: number) {
    const voice = this.voice;
    if (!this.currentFollow(session, attempt) || !this.client || !voice) return;
    if (!this.desiredChannelId) await this.locateUserChannel(session, attempt);
    if (!this.currentFollow(session, attempt) || !this.voice) return;
    const channel = await this.resolveDesiredChannel();
    if (!this.currentFollow(session, attempt) || !this.voice) return;
    if (!channel) {
      this.leaveVoice();
      this.setStatus("waiting", "");
      return;
    }

    const current = this.connection;
    const settled = Boolean(
      current &&
      current.joinConfig.channelId === channel.id &&
      current.state.status === voice.VoiceConnectionStatus.Ready
    );
    if (settled) {
      if (!this.captureHost) await this.startCapture();
      if (!this.currentFollow(session, attempt)) return;
      this.applyPlayback(this.getService(PlayerStateStore).getState());
      return;
    }

    this.setStatus("connecting", "");
    await this.joinChannel(session, attempt, voice, channel);
    if (!this.currentFollow(session, attempt) || this.connection?.state.status !== voice.VoiceConnectionStatus.Ready) return;
    if (!this.captureHost) await this.startCapture();
    if (!this.currentFollow(session, attempt)) return;
    this.applyPlayback(this.getService(PlayerStateStore).getState());
  }

  private async joinChannel(session: number, attempt: number, voice: typeof import("@discordjs/voice"), channel: VoiceBasedChannel) {
    if (!this.currentFollow(session, attempt)) return;

    // Reusing a live connection does not renegotiate DAVE, so a move or a drop leaves the bot stuck.
    const tracked = voice.getVoiceConnection(channel.guild.id);
    const hadConnection = Boolean(this.connection) || Boolean(tracked);
    this.dropConnection();
    if (tracked && tracked.state.status !== voice.VoiceConnectionStatus.Destroyed) {
      tracked.removeAllListeners();
      try {
        tracked.destroy();
      } catch {
        // The tracked connection is already closed.
      }
    }
    if (hadConnection) {
      await delay(300);
      if (!this.currentFollow(session, attempt)) return;
    }

    const connection = voice.joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });
    if (!this.currentFollow(session, attempt)) {
      connection.removeAllListeners();
      try {
        connection.destroy();
      } catch {
        // The new connection was superseded before it opened.
      }
      return;
    }
    this.connection = connection;
    if (!this.player) {
      this.leaveVoice();
      return;
    }
    connection.subscribe(this.player);
    let becameReady = false;
    connection.on(voice.VoiceConnectionStatus.Ready, () => {
      becameReady = true;
    });
    connection.on(voice.VoiceConnectionStatus.Disconnected, () => {
      // Ignore drops during the first handshake. entersState reports that failure itself.
      if (!becameReady || this.connection !== connection || session !== this.generation) return;
      log.warn("Discord voice connection lost");
      this.queueFollow(session);
    });

    try {
      await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
      if (!this.currentFollow(session, attempt) || this.connection !== connection) return;
      throw error;
    }
    if (!this.currentFollow(session, attempt) || this.connection !== connection) {
      if (this.connection === connection) this.dropConnection();
      return;
    }

    if (this.resource?.encoder) {
      const channelBitrate = "bitrate" in channel && typeof channel.bitrate === "number" ? channel.bitrate : MIN_MUSIC_BITRATE;
      this.playbackBitrate = configureMusicEncoder(this.resource.encoder, channelBitrate);
      log.info(`Discord voice encoding music at ${Math.round(this.playbackBitrate / 1000)} kbps`);
    }

    const { ChannelType } = await import("discord.js");
    if (channel.type === ChannelType.GuildStageVoice) {
      try {
        const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe());
        if (!this.currentFollow(session, attempt)) return;
        await me.voice.setSuppressed(false);
      } catch (error) {
        log.warn("Could not promote the bot to a stage speaker", redact(error, null));
      }
    }
    if (!this.currentFollow(session, attempt) && this.connection === connection) this.dropConnection();
  }

  private openPlaybackResource() {
    const voice = this.voice;
    if (!voice) return null;
    const previous = this.pcmStream;
    this.droppingPcm = false;
    this.pcmStream = new PassThrough({ highWaterMark: PCM_HIGH_WATER_MARK });
    previous?.destroy();
    const resource = voice.createAudioResource(this.pcmStream, {
      inputType: voice.StreamType.Raw,
      inlineVolume: false
    });
    if (resource.encoder) configureMusicEncoder(resource.encoder, this.playbackBitrate);
    this.resource = resource;
    return resource;
  }

  private applyPlayback(state: PlayerState) {
    try {
      const output = shouldOutput(state);
      if (output !== this.outputEnabled) this.sendToCaptureHost("discordVoice:setOutput", output);
      this.outputEnabled = output;
      if (!output) this.discardBufferedPcm();
      this.updatePresence(state);

      const player = this.player;
      const voice = this.voice;
      if (player && voice) {
        const status = player.state.status;
        if (output) {
          const resourceEnded = !this.resource || this.resource.ended;
          if (status === voice.AudioPlayerStatus.Idle || resourceEnded) {
            const resource = resourceEnded ? this.openPlaybackResource() : this.resource;
            if (resource && !resource.ended) player.play(resource);
          } else if (status === voice.AudioPlayerStatus.Paused) {
            player.unpause();
          }
        } else if (status === voice.AudioPlayerStatus.Playing) {
          player.pause();
        }
      }

      if (this.connection?.state.status === voice?.VoiceConnectionStatus.Ready) {
        this.setStatus(output ? "live" : "paused", this.status === "error" ? "" : this.detail);
      }
    } catch (error) {
      const message = redact(error, null);
      log.error("Discord voice playback failed", message);
      this.setStatus("error", message);
    }
  }

  private discardBufferedPcm() {
    const stream = this.pcmStream;
    if (!stream || stream.destroyed) return;
    while (stream.read() !== null) continue;
  }

  private updatePresence(state: PlayerState) {
    const title = state.videoDetails?.title?.trim() || "YouTube Music";
    const key = `${shouldOutput(state)}:${title}`;
    if (key === this.presenceKey || !this.client?.user) return;
    this.presenceKey = key;
    const name = title.length > 128 ? title.slice(0, 125).trimEnd() + "..." : title;
    void import("discord.js").then(discord => {
      this.client?.user?.setActivity(name, { type: discord.ActivityType.Listening });
    });
  }

  private captureHostContents() {
    const windows = this.getService(AppWindowManager);
    if (!windows.hasWindow("Main")) return null;
    const contents = windows.getWindow("Main").webContents;
    if (!contents || contents.isDestroyed()) return null;
    return contents;
  }

  private sendToCaptureHost(channel: string, ...args: unknown[]) {
    const host = this.captureHost;
    if (!host || host.isDestroyed()) return;
    host.send(channel, ...args);
  }

  private async startCapture() {
    this.installDisplayMediaHandler();
    const host = this.captureHostContents();
    if (!host) throw new Error("The main window is not available to capture audio.");
    // Capture runs in the title bar, which is already open. A second window was a full Chromium process.
    host.setBackgroundThrottling(false);
    host.removeListener("did-finish-load", this.onCaptureHostLoaded);
    host.on("did-finish-load", this.onCaptureHostLoaded);
    this.captureHost = host;
    host.send("discordVoice:setOutput", this.outputEnabled);
    host.send("discordVoice:setActive", true);
  }

  private stopCapture() {
    session.defaultSession.setDisplayMediaRequestHandler(null);
    const host = this.captureHost;
    this.captureHost = null;
    if (!host || host.isDestroyed()) return;
    host.removeListener("did-finish-load", this.onCaptureHostLoaded);
    host.send("discordVoice:setActive", false);
    host.setBackgroundThrottling(true);
  }

  private dropConnection() {
    const connection = this.connection;
    this.connection = null;
    if (!connection) return;
    connection.removeAllListeners();
    try {
      connection.destroy();
    } catch (error) {
      log.warn("Discord voice connection was already closed", error);
    }
  }

  private leaveVoice() {
    this.dropConnection();
    const voice = this.voice;
    const client = this.client;
    if (voice && client) {
      for (const guild of client.guilds.cache.values()) {
        const tracked = voice.getVoiceConnection(guild.id);
        if (!tracked || tracked.state.status === voice.VoiceConnectionStatus.Destroyed) continue;
        tracked.removeAllListeners();
        try {
          tracked.destroy();
        } catch {
          // That guild's connection is already closed.
        }
      }
    }
    this.stopCapture();
  }

  private installDisplayMediaHandler() {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const frameUrl = request.frame?.url ?? "";
      const fromCaptureHost = isCaptureHostFrame(frameUrl);
      const ytmContents = this.getService(YTMViewManager).getView()?.webContents;
      if (!fromCaptureHost || !ytmContents || ytmContents.isDestroyed() || !ytmContents.mainFrame) {
        callback(null);
        return;
      }

      // Local echo stays off so YouTube Music is silent in the app while this capture is live.
      // Discord is the only output. Electron restores app audio when the capture ends.
      callback({
        video: ytmContents.mainFrame,
        audio: ytmContents.mainFrame,
        enableLocalEcho: false
      });
    });
  }

  private trimDiscordCache() {
    const client = this.client;
    if (!client) return;
    const keepUsers = new Set<string>();
    if (client.user?.id) keepUsers.add(client.user.id);
    if (this.followedUserId) keepUsers.add(this.followedUserId);

    for (const [id] of client.users.cache) {
      if (!keepUsers.has(id)) client.users.cache.delete(id);
    }

    for (const guild of client.guilds.cache.values()) {
      for (const [id] of guild.voiceStates.cache) {
        if (id !== this.followedUserId) guild.voiceStates.cache.delete(id);
      }
      const me = client.user?.id;
      for (const [id] of guild.members.cache) {
        if (id !== me) guild.members.cache.delete(id);
      }
      guild.presences.cache.clear();
      guild.emojis.cache.clear();
      guild.stickers.cache.clear();
      guild.stageInstances.cache.clear();
      guild.scheduledEvents.cache.clear();

      const keepChannels = new Set<string>();
      for (const channel of guild.channels.cache.values()) {
        if (typeof channel.isVoiceBased !== "function" || !channel.isVoiceBased()) continue;
        keepChannels.add(channel.id);
        if ("parentId" in channel && typeof channel.parentId === "string") keepChannels.add(channel.parentId);
      }
      for (const [id] of guild.channels.cache) {
        if (keepChannels.has(id)) continue;
        guild.channels.cache.delete(id);
        client.channels.cache.delete(id);
      }
    }
  }

  private stopResources() {
    this.outputEnabled = false;
    this.presenceKey = "";
    this.droppingPcm = false;
    if (this.cacheTimer) {
      clearInterval(this.cacheTimer);
      this.cacheTimer = null;
    }

    ipcMain.removeListener("discordVoice:pcm", this.onPcm);
    ipcMain.removeListener("discordVoice:captureError", this.onCaptureError);
    ipcMain.removeListener("discordVoice:captureStarted", this.onCaptureStarted);

    if (this.stateCallback) {
      this.getService(PlayerStateStore).off("state-changed", this.stateCallback);
      this.stateCallback = null;
    }
    if (this.viewRecreated) {
      this.getService(YTMViewManager).off("view-recreated", this.viewRecreated);
      this.viewRecreated = null;
    }

    this.leaveVoice();
    this.player?.stop();
    this.client?.destroy();
    this.pcmStream?.destroy();

    this.player = null;
    this.client = null;
    this.resource = null;
    this.pcmStream = null;
    this.voice = null;
    this.playbackBitrate = MIN_MUSIC_BITRATE;
    this.followedUserId = "";
    this.desiredChannelId = null;
    this.startupSettled = false;
    this.voiceRevision++;
    this.followAttempt++;
    this.followChain = Promise.resolve();
  }

  private setStatus(status: string, detail: string) {
    if (this.status === status && this.detail === detail) return;
    this.status = status;
    this.detail = detail;
    const memoryStore = this.getService(MemoryStore<MemoryStoreSchema>);
    memoryStore.set("discordVoiceStatus", status);
    memoryStore.set("discordVoiceDetail", detail);
  }

  private safeStorageAvailable() {
    return this.getService(MemoryStore<MemoryStoreSchema>).get("safeStorageAvailable") === true;
  }

  private async readToken(): Promise<string | null> {
    if (!this.safeStorageAvailable()) return null;

    const stored = this.getService(ConfigStore).get("integrations.discordVoiceBotToken");
    if (!stored) return null;
    try {
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(stored, "hex"));
      const token = decrypted.result.trim();
      return token.length > 0 ? token : null;
    } catch (error) {
      log.error("Could not decrypt the Discord bot token", error);
      return null;
    }
  }
}
