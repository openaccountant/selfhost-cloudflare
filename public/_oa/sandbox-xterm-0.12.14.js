//#region src/xterm/addon.ts
const DEFAULT_RECONNECT_DELAY = 1e3;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_BACKOFF_EXPONENT = 5;
const JITTER_FACTOR = .1;
var SandboxAddon = class {
	terminal = null;
	socket = null;
	disposables = [];
	reconnectAttempts = 0;
	reconnectTimer = null;
	hasReceivedBuffer = false;
	intentionalDisconnect = false;
	textEncoder = new TextEncoder();
	_state = "disconnected";
	_sandboxId;
	_sessionId;
	get state() {
		return this._state;
	}
	get sandboxId() {
		return this._sandboxId;
	}
	get sessionId() {
		return this._sessionId;
	}
	constructor(options) {
		this.options = options;
	}
	activate(terminal) {
		this.terminal = terminal;
	}
	dispose() {
		this.intentionalDisconnect = true;
		this.cancelReconnect();
		this.closeSocket();
		this.terminal = null;
	}
	connect(target) {
		if (!this.terminal) return;
		if (target.sandboxId === this._sandboxId && target.sessionId === this._sessionId && this._state !== "disconnected") return;
		this._sandboxId = target.sandboxId;
		this._sessionId = target.sessionId;
		this.cancelReconnect();
		this.closeSocket();
		this.reconnectAttempts = 0;
		this.intentionalDisconnect = false;
		if (this._state !== "disconnected") this.terminal.clear();
		this.doConnect();
	}
	disconnect() {
		this.intentionalDisconnect = true;
		this.cancelReconnect();
		this.closeSocket();
		this.setState("disconnected");
	}
	setState(state, error) {
		if (this._state === state) return;
		this._state = state;
		this.options.onStateChange?.(state, error);
	}
	doConnect() {
		if (!this.terminal || !this._sandboxId) return;
		this.setState("connecting");
		this.hasReceivedBuffer = false;
		const origin = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
		const url = this.options.getWebSocketUrl({
			sandboxId: this._sandboxId,
			sessionId: this._sessionId,
			origin
		});
		const socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";
		this.socket = socket;
		this.registerSocketListener(socket, "open", this.onSocketOpen.bind(this));
		this.registerSocketListener(socket, "message", (e) => this.onSocketMessage(e));
		this.registerSocketListener(socket, "close", this.onSocketClose.bind(this));
		this.registerSocketListener(socket, "error", this.onSocketError.bind(this));
	}
	registerSocketListener(socket, type, listener) {
		socket.addEventListener(type, listener);
		this.disposables.push({ dispose: () => socket.removeEventListener(type, listener) });
	}
	onSocketOpen() {
		if (!this.terminal) return;
		this.disposables.push(this.terminal.onData((data) => this.sendData(data)));
		this.disposables.push(this.terminal.onResize(({ cols, rows }) => this.sendResize(cols, rows)));
	}
	onSocketMessage(event) {
		if (!this.terminal) return;
		const { data } = event;
		if (data instanceof ArrayBuffer) {
			this.hasReceivedBuffer = true;
			this.terminal.write(new Uint8Array(data));
			return;
		}
		if (typeof data === "string") try {
			const msg = JSON.parse(data);
			this.handleControlMessage(msg);
		} catch {}
	}
	handleControlMessage(msg) {
		switch (msg.type) {
			case "ready":
				if (!this.hasReceivedBuffer) this.terminal?.clear();
				this.reconnectAttempts = 0;
				this.setState("connected");
				this.terminal?.focus();
				if (this.terminal) this.sendResize(this.terminal.cols, this.terminal.rows);
				break;
			case "error":
				this.options.onStateChange?.(this._state, new Error(msg.message ?? "Unknown error"));
				break;
			case "exit":
				this.options.onStateChange?.(this._state, /* @__PURE__ */ new Error(`Session exited with code ${msg.code}${msg.signal ? ` (${msg.signal})` : ""}`));
				break;
		}
	}
	onSocketClose() {
		this.closeSocket();
		if (this.intentionalDisconnect) {
			this.setState("disconnected");
			return;
		}
		if (!(this.options.reconnect !== false)) {
			this.setState("disconnected");
			return;
		}
		if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			this.setState("disconnected", /* @__PURE__ */ new Error("Max reconnection attempts exceeded"));
			return;
		}
		this.scheduleReconnect();
	}
	onSocketError() {
		this.options.onStateChange?.(this._state, /* @__PURE__ */ new Error("WebSocket error"));
	}
	scheduleReconnect() {
		const delay = DEFAULT_RECONNECT_DELAY * 2 ** Math.min(this.reconnectAttempts, MAX_BACKOFF_EXPONENT);
		const jitter = delay * JITTER_FACTOR * Math.random();
		this.setState("disconnected");
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.reconnectAttempts++;
			this.terminal?.clear();
			this.doConnect();
		}, delay + jitter);
	}
	cancelReconnect() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}
	closeSocket() {
		if (this.socket) {
			this.socket.close();
			this.socket = null;
		}
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
	}
	sendData(data) {
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(this.textEncoder.encode(data));
	}
	sendResize(cols, rows) {
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({
			type: "resize",
			cols,
			rows
		}));
	}
};

//#endregion
export { SandboxAddon };
//# sourceMappingURL=index.js.map