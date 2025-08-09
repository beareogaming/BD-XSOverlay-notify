/**
 * @name XSOverlayNotifier
 * @author Ko
 * @version 2.7.0
 * @description Sends Discord notifications to XSOverlay (SteamVR) over the official WebSocket API. Single-port (default 42070), avatar-as-icon, default chime, strict trimming (no blank lines), optional dynamic toast height, queue cap, markdown stripping, embed/sticker handling, jittered reconnect.
 * @source https://example.com/XSOverlayNotifier.plugin.js
 * @updateUrl https://example.com/XSOverlayNotifier.plugin.js
 */

module.exports = class XSOverlayNotifier {
    constructor() {
        this.meta = { name: "XSOverlayNotifier", version: "2.7.0" };

        this.defaultSettings = {
            host: "127.0.0.1",
            port: 42070,
            autoConnect: true,

            // filters
            notifyDMs: true,
            notifyMentions: true,
            notifyGuildMessages: false,
            includeChannelName: true,

            // timings
            timeoutMs: 5000,        // converted to seconds for WS API
            minIntervalMs: 800,
            logDebug: true,

            // WS client id
            clientName: "XSOverlayNotifier",

            // XSOverlay visual/audio defaults
            volume: 0.7,            // 0..1
            opacity: 1,             // 0..1

            // height behavior
            autoHeight: true,       // <-- NEW: dynamically size by content length
            height: 175,            // used when autoHeight = false
            minHeight: 140,         // clamp lower bound for autoHeight
            maxHeight: 520,         // clamp upper bound for autoHeight
            lineHeight: 18,         // px per wrapped text line
            wrapChars: 38,          // characters per visual line before wrapping
            basePadding: 92,        // header/icon/padding base height added to lines

            // icon/audio config
            forceDefaultSound: true,    // always play XSOverlay default chime
            avatarIcon: true,           // use author's avatar as icon
            fallbackIcon: "",           // "", "default"/"error"/"warning", file path, or base64
            useBase64Icon: true         // keep true for avatar data
        };

        this.ws = null;
        this.queue = [];
        this.connected = false;
        this.connecting = false;
        this._lastSentAt = 0;
        this._backoff = 1000;
        this._backoffMax = 15000;
        this._maxQueue = 200;
    }

    /* ========================= BetterDiscord Lifecycle ========================= */

    load() {
        this.settings = Object.assign({}, this.defaultSettings, BdApi.loadData(this.meta.name, "settings") || {});
        this._bindInternals();
        this._log("Loaded.");
    }

    start() {
        this._subscribe();
        if (this.settings.autoConnect) this._connect();
        this._log("Started.");
    }

    stop() {
        this._unsubscribe();
        this._disconnect(true);
        this._log("Stopped.");
    }

    /* ============================= Settings Panel ============================= */

    getSettingsPanel() {
        const React = BdApi.React;
        const useState = React.useState;

        const Row = ({label, children}) =>
            React.createElement("div", {style:{display:"flex", alignItems:"center", gap:10, margin:"8px 0"}},
                React.createElement("div", {style:{width:270, fontWeight:600}}, label),
                React.createElement("div", null, children)
            );

        const Bool = ({k, label}) => {
            const [val, setVal] = useState(this.settings[k]);
            return Row({
                label,
                children: React.createElement("input", {
                    type: "checkbox",
                    checked: val,
                    onChange: e => { this.settings[k] = e.target.checked; setVal(e.target.checked); this._save(); }
                })
            });
        };

        const NumberInput = ({k, label, min=0, step=1}) => {
            const [val, setVal] = useState(this.settings[k]);
            return Row({
                label,
                children: React.createElement("input", {
                    type: "number",
                    value: val,
                    min,
                    step,
                    style: {width:120},
                    onChange: e => {
                        const num = Number(e.target.value);
                        if (!Number.isNaN(num)) { this.settings[k] = num; setVal(num); this._save(); }
                    }
                })
            });
        };

        const TextInput = ({k, label, width=260}) => {
            const [val, setVal] = useState(this.settings[k]);
            return Row({
                label,
                children: React.createElement("input", {
                    type: "text",
                    value: val,
                    style: {width},
                    onChange: e => { this.settings[k] = e.target.value; setVal(e.target.value); this._save(); }
                })
            });
        };

        const Button = ({label, onClick}) => React.createElement("button", {
            className: "bd-button bd-button-filled",
            style: {padding:"6px 10px", borderRadius:8},
            onClick
        }, label);

        const Panel = () => {
            const [, force] = useState(0);
            const reconnect = () => { this._disconnect(); this._connect(true); force(x => x+1); };
            const testPing = () => this._sendToOverlay("BetterDiscord", "Discord overlay online", this.settings.timeoutMs);

            return React.createElement("div", {style:{padding:12}},
                React.createElement("h3", null, "XSOverlay Notifier"),
                TextInput({k:"host", label:"Host"}),
                NumberInput({k:"port", label:"Port"}),
                TextInput({k:"clientName", label:"Client name (WS ?client=...)"}),
                React.createElement("hr", null),
                Bool({k:"notifyDMs", label:"Notify: Direct Messages"}),
                Bool({k:"notifyMentions", label:"Notify: Mentions (@you/@here/@everyone)"}),
                Bool({k:"notifyGuildMessages", label:"Notify: All guild messages (noisy)"}),
                Bool({k:"includeChannelName", label:"Include channel/server name"}),
                NumberInput({k:"timeoutMs", label:"Toast timeout (ms)", min:500, step:500}),
                NumberInput({k:"minIntervalMs", label:"Min interval between toasts (ms)", min:0, step:100}),
                React.createElement("hr", null),

                Bool({k:"autoHeight", label:"Auto height based on message length"}),
                NumberInput({k:"height", label:"Fixed height (if auto off)", min:100, step:5}),
                NumberInput({k:"minHeight", label:"Min height (auto)", min:80, step:5}),
                NumberInput({k:"maxHeight", label:"Max height (auto)", min:120, step:10}),
                NumberInput({k:"lineHeight", label:"Line height (px)", min:10, step:1}),
                NumberInput({k:"wrapChars", label:"Wrap at ~chars/line", min:20, step:1}),
                NumberInput({k:"basePadding", label:"Base padding (px)", min:60, step:2}),

                React.createElement("hr", null),
                NumberInput({k:"opacity", label:"Opacity (0-1)", min:0, step:0.1}),
                NumberInput({k:"volume", label:"Volume (0-1)", min:0, step:0.1}),
                Bool({k:"forceDefaultSound", label:"Always use default XSOverlay sound"}),
                Bool({k:"avatarIcon", label:"Use sender's avatar as icon"}),
                TextInput({k:"fallbackIcon", label:"Fallback icon (keyword/path/base64)"}),
                Bool({k:"useBase64Icon", label:"Send icon as base64"}),

                React.createElement("hr", null),
                Bool({k:"autoConnect", label:"Auto-connect at startup"}),
                Bool({k:"logDebug", label:"Debug logging"}),

                React.createElement("div", {style:{display:"flex", gap:8, marginTop:12}},
                    Button({label: this.connected ? "Connected" : (this.connecting ? "Connecting…" : "Connect"), onClick: reconnect}),
                    Button({label:"Send Test", onClick: testPing})
                ),
                React.createElement("div", {style:{marginTop:6, opacity:0.7, fontSize:12}},
                    `Status: ${this.connected ? "Connected" : (this.connecting ? "Connecting" : "Disconnected")} · Target: ${this._targetUrl()}`
                )
            );
        };
        return React.createElement(Panel);
    }

    /* =============================== Discord Hooks ============================ */

    _bindInternals() {
        const W = BdApi.Webpack;
        this.Dispatcher = W.getModule(m => m?.subscribe && m?.dispatch);
        this.ChannelStore = W.getModule(m => m?.getChannel && m?.getDMFromUserId);
        this.UserStore = W.getModule(m => m?.getCurrentUser && m?.getUser);
        this.GuildStore = W.getModule(m => m?.getGuild && m?.getGuilds);

        this._onMessageCreate = this._onMessageCreate.bind(this);
        this._onWSOpen = this._onWSOpen.bind(this);
        this._onWSMessage = this._onWSMessage.bind(this);
        this._onWSClose = this._onWSClose.bind(this);
        this._onWSError = this._onWSError.bind(this);
    }

    _subscribe() {
        if (!this.Dispatcher) return;
        this.Dispatcher.subscribe("MESSAGE_CREATE", this._onMessageCreate);
    }

    _unsubscribe() {
        if (!this.Dispatcher) return;
        try { this.Dispatcher.unsubscribe("MESSAGE_CREATE", this._onMessageCreate); } catch {}
    }

    async _onMessageCreate({ message }) {
        try {
            if (!message || !message.id) return;
            const me = this.UserStore?.getCurrentUser?.();
            if (!me) return;

            const ch = this.ChannelStore?.getChannel?.(message.channel_id);
            if (!ch) return;

            // Ignore my own messages
            if (message.author?.id === me.id) return;

            const isDM = ch.type === 1 || ch.type === 3; // 1: DM, 3: Group DM
            const isMention = this._isMention(me.id, message);
            const isGuildMsg = ch.guild_id != null;

            if (
                (isDM && this.settings.notifyDMs) ||
                (isMention && this.settings.notifyMentions) ||
                (isGuildMsg && this.settings.notifyGuildMessages)
            ) {
                const authorName = this._displayName(message, ch);
                const title = this._cap((authorName || "Discord"), 128);

                let content = this._sanitize((message.content || ""));

                // Handle embeds/stickers/attachments when no plain content
                if (!content) {
                    if (message.sticker_items?.length) {
                        content = `[sticker] ${(message.sticker_items[0]?.name || "").trim()}`;
                    } else if (message.embeds?.length) {
                        const e = message.embeds[0] || {};
                        content = `[embed] ${this._sanitize(e.title || e.description || "")}`.trim();
                    }
                }
                if (!content && message.attachments?.length) {
                    content = `[${message.attachments.length} attachment${message.attachments.length > 1 ? "s" : ""}]`;
                }

                // Include channel/server context without injecting blank lines
                if (this.settings.includeChannelName) {
                    const cx = this._channelContext(ch).trim();
                    if (cx) {
                        if (content) content = `${cx} — ${content.trim()}`;
                        else content = cx;
                    }
                }

                // STRICT FINAL TRIM
                content = (content || "")
                    .replace(/\r\n/g, "\n")
                    .replace(/^\s+|\s+$/g, "")
                    .replace(/^\n+/, "")
                    .replace(/\n+$/, "")
                    .replace(/\n{2,}/g, "\n");

                // Fetch avatar (base64) if enabled; fail fast and still notify
                let iconBase64 = null;
                if (this.settings.avatarIcon) {
                    try {
                        iconBase64 = await this._fetchAuthorAvatarBase64(message);
                    } catch (e) {
                        this._log("Avatar fetch failed", e?.message || e);
                    }
                }

                this._sendToOverlay(title, content || "(no text)", this.settings.timeoutMs, iconBase64);
            }
        } catch (e) {
            this._log("onMessage error", e);
        }
    }

    _isMention(myId, message) {
        if (!message) return false;
        if (message.mention_everyone) return true;
        if (message.content && (message.content.includes(`<@${myId}>`) || message.content.includes(`<@!${myId}>`))) return true;
        if (Array.isArray(message.mentions) && message.mentions.some(m => m?.id === myId)) return true;
        return false;
    }

    _displayName(message, channel) {
        const author = message.author;
        if (!author) return "Unknown";
        if (channel?.guild_id && message.member?.nick) return `${message.member.nick}`;
        return `${author.username}`;
    }

    _channelContext(ch) {
        try {
            if (!ch) return "";
            if (ch.type === 1) return "Direct Message";
            if (ch.type === 3) return ch.name ? `Group DM · #${ch.name}` : "Group DM";
            if (ch.guild_id) {
                const guild = this.GuildStore?.getGuild?.(ch.guild_id);
                const guildName = guild?.name ?? "Server";
                const chanName = ch.name ? `#${ch.name}` : "Channel";
                return `${guildName} · ${chanName}`;
            }
        } catch {}
        return "";
    }

    /* =========================== XSOverlay Connection ========================= */

    _targetUrl() {
        const host = (this.settings.host || this.defaultSettings.host).trim();
        const port = Number(this.settings.port) || this.defaultSettings.port;
        const client = encodeURIComponent(this.settings.clientName || this.defaultSettings.clientName);
        return `ws://${host}:${port}/?client=${client}`;
    }

    _connect(force = false) {
        if ((this.connected || this.connecting) && !force) return;
        if (force) this._disconnect();

        const url = this._targetUrl();
        this.connecting = true;

        try {
            this.ws = new WebSocket(url);
        } catch (e) {
            this._log("WS ctor failed", e);
            this.connecting = false;
            return this._scheduleReconnect();
        }

        this.ws.addEventListener("open", this._onWSOpen);
        this.ws.addEventListener("message", this._onWSMessage);
        this.ws.addEventListener("close", this._onWSClose);
        this.ws.addEventListener("error", this._onWSError);
        this._log(`Connecting to XSOverlay WS: ${url}`);
    }

    _onWSOpen() {
        this.connected = true;
        this.connecting = false;
        this._backoff = 1000;
        this._log("XSOverlay connected.");

        const hello = this._buildNotification("BetterDiscord", "Discord overlay online", 2500, null, "Hello");
        this._sendRaw(this._buildEnvelope(hello));

        while (this.queue.length && this.connected) this._sendRaw(this.queue.shift());
    }

    _onWSMessage(ev) {
        if (this.settings.logDebug) this._log("WS <-", ev?.data);
    }

    _onWSClose() {
        this._log("XSOverlay disconnected.");
        this.connected = false;
        this.connecting = false;
        this._scheduleReconnect();
    }

    _onWSError(err) {
        this._log("WS error", err);
        this._disconnect(true);
        this.connecting = false;
        this._scheduleReconnect();
    }

    _disconnect(silent = false) {
        if (this.ws) {
            try {
                this.ws.removeEventListener("open", this._onWSOpen);
                this.ws.removeEventListener("message", this._onWSMessage);
                this.ws.removeEventListener("close", this._onWSClose);
                this.ws.removeEventListener("error", this._onWSError);
                this.ws.close();
            } catch {}
            this.ws = null;
        }
        this.connected = false;
        this.connecting = false;
        if (!silent) this._log("Disconnected from XSOverlay.");
    }

    _scheduleReconnect() {
        if (!this.settings.autoConnect) return;
        const jitter = Math.floor(Math.random() * 400);
        const wait = this._backoff + jitter;
        this._backoff = Math.min(this._backoff * 2, this._backoffMax);
        this._log(`Reconnecting in ${Math.floor(wait/1000)}s…`);
        setTimeout(() => this._connect(), wait);
    }

    /* ================================ Sending ================================= */

    _sendToOverlay(titleText, contentText, timeoutMs, iconBase64) {
        const now = Date.now();
        const delta = now - this._lastSentAt;
        const delay = Math.max(0, (Number(this.settings.minIntervalMs) || 0) - delta);

        const title = this._cap((String(titleText) || "Discord"), 128) || "Discord";
        const body  = this._cap((String(contentText) || "(no text)"), 1024);

        const note = this._buildNotification(title, body, timeoutMs, iconBase64, body);

        setTimeout(() => {
            this._lastSentAt = Date.now();
            const envelope = this._buildEnvelope(note);
            if (this.connected) this._sendRaw(envelope);
            else {
                if (this.queue.length >= this._maxQueue) this.queue.shift();
                this.queue.push(envelope);
            }
        }, delay);
    }

    _buildNotification(title, content, timeoutMs, iconBase64, forAutoSize) {
        const timeoutSeconds = Math.max(0.5, (Number(timeoutMs) || this.settings.timeoutMs || 5000) / 1000);
        const audioPath = this.settings.forceDefaultSound ? "default" : "";

        // ----- Dynamic height calculation -----
        const h = this.settings.autoHeight
            ? this._estimateHeight(forAutoSize || content || "")
            : Number(this.settings.height) || 175;

        let useBase64Icon = !!iconBase64;
        let icon = iconBase64 || (this.settings.fallbackIcon || "");
        if (!useBase64Icon && this.settings.useBase64Icon && typeof icon === "string" && icon.startsWith("data:")) {
            icon = icon.replace(/^data:image\/\w+;base64,/, "");
            useBase64Icon = true;
        }

        return {
            type: 1,
            index: 0,
            timeout: timeoutSeconds,
            height: h,
            opacity: Math.max(0, Math.min(1, Number(this.settings.opacity) || 1)),
            volume: Math.max(0, Math.min(1, Number(this.settings.volume) || 0.7)),
            audioPath,
            title,
            content,
            useBase64Icon,
            icon,
            sourceApp: this.settings.clientName || "XSOverlayNotifier"
        };
    }

    // Heuristic: estimate wrapped lines, then convert to pixels with lineHeight,
    // add base padding (icon/title/padding), clamp between minHeight/maxHeight.
    _estimateHeight(text) {
        const s = this.settings;
        const wrapChars = Math.max(20, Number(s.wrapChars) || 38);
        const lineHeight = Math.max(12, Number(s.lineHeight) || 18);
        const basePadding = Math.max(60, Number(s.basePadding) || 92);
        const minH = Math.max(80, Number(s.minHeight) || 140);
        const maxH = Math.max(minH, Number(s.maxHeight) || 520);

        // count visual lines after wrapping
        let lines = 0;
        String(text).split("\n").forEach(line => {
            const len = (line || "").length;
            const wrapped = Math.max(1, Math.ceil(len / wrapChars));
            lines += wrapped;
        });

        const contentHeight = lines * lineHeight;
        const total = Math.round(basePadding + contentHeight);
        return Math.max(minH, Math.min(maxH, total));
    }

    _buildEnvelope(notificationObj) {
        return {
            sender: this.settings.clientName || "XSOverlayNotifier",
            target: "xsoverlay",
            command: "SendNotification",
            jsonData: JSON.stringify(notificationObj),
            rawData: null
        };
    }

    _sendRaw(obj) {
        try {
            const json = JSON.stringify(obj);
            if (this.settings.logDebug) this._log("WS ->", json);
            this.ws?.send(json);
        } catch (e) {
            this._log("Send failed", e);
        }
    }

    /* ============================== Avatar fetch ============================== */

    async _fetchAuthorAvatarBase64(message) {
        const author = message?.author;
        if (!author?.id) return null;

        let url;
        if (author.avatar) {
            url = `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=128`;
        } else {
            let idx = 0;
            if (author.discriminator && /^\d+$/.test(author.discriminator)) {
                idx = Number(author.discriminator) % 5;
            } else {
                try { idx = Number(BigInt(author.id) % 5n); } catch { idx = 0; }
            }
            url = `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
        }

        const base64 = await this._fetchImageAsBase64(url);
        return base64; // raw base64 (no data: prefix)
    }

    async _fetchImageAsBase64(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    /* ================================= Utils ================================== */

    _sanitize(text = "") {
        return String(text)
            .replace(/<a?:\w+:\d+>/g, " ")          // custom emoji
            .replace(/<@!?(\d+)>/g, "@mention")      // user mentions
            .replace(/<@&(\d+)>/g, "@role")          // role mentions
            .replace(/<#(\d+)>/g, "#channel")        // channel mentions
            .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1") // *italic*, **bold**, ***bold+it***
            .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")   // code spans/blocks
            .replace(/\[(.*?)\]\((.*?)\)/g, "$1")    // markdown links
            .replace(/\u200B/g, "")                  // zero-width
            .replace(/\r\n/g, "\n")
            .replace(/^\s+|\s+$/g, "")
            .replace(/^\n+/, "")
            .replace(/\n+$/, "")
            .replace(/\n{2,}/g, "\n");
    }

    _cap(str, n) {
        const s = String(str || "");
        return s.length > n ? s.slice(0, n) : s;
    }

    _save() {
        BdApi.saveData(this.meta.name, "settings", this.settings);
    }

    _log(...args) {
        const head = String(args?.[0] ?? "");
        const important = /Loaded|Started|Stopped|Connecting|connected|disconnected|Reconnecting|failed/i.test(head);
        if (this.settings?.logDebug || important) console.log(`[${this.meta.name}]`, ...args);
    }
};
