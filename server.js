// Minimal WebRTC signaling server for Godot multiplayer.
// Deploy this to Render.com or Fly.io (free tier). Godot clients connect
// to it over WebSocket to exchange offers/answers/ICE candidates, then
// talk directly to each other peer-to-peer via WebRTC once connected.
//
// This server does NOT relay game traffic — only the initial handshake.
// After connection, players talk directly (or via STUN/TURN if needed),
// so this server can be tiny and stay well within free tier limits.

const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// lobbies: code -> { host: ws|null, hostId: number, peers: Map<peerId, ws> }
const lobbies = new Map();

function send(ws, msg) {
	if (ws && ws.readyState === ws.OPEN) {
		ws.send(JSON.stringify(msg));
	}
}

function generateLobbyCode() {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let code = '';
	for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
	return code;
}

wss.on('connection', (ws) => {
	ws.lobbyCode = null;
	ws.peerId = null;

	ws.on('message', (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch (e) {
			return;
		}

		switch (msg.type) {
			case 'host': {
				let code = generateLobbyCode();
				while (lobbies.has(code)) code = generateLobbyCode();
				ws.lobbyCode = code;
				ws.peerId = 1;
				lobbies.set(code, {
					host: ws,
					peers: new Map([[1, ws]]),
					nextPeerId: 2,
					maxPlayers: msg.maxPlayers || 8,
					playerName: msg.playerName || 'Host',
				});
				send(ws, { type: 'hosted', code, peerId: 1 });
				break;
			}

			case 'list': {
				const list = [];
				for (const [code, lobby] of lobbies.entries()) {
					list.push({
						code,
						playerCount: lobby.peers.size,
						maxPlayers: lobby.maxPlayers,
						hostName: lobby.playerName,
					});
				}
				send(ws, { type: 'lobby_list', lobbies: list });
				break;
			}

			case 'join': {
				const code = (msg.code || '').toUpperCase();
				const lobby = lobbies.get(code);
				if (!lobby) {
					send(ws, { type: 'join_failed', reason: 'Lobby not found: ' + code });
					return;
				}
				if (lobby.peers.size >= lobby.maxPlayers) {
					send(ws, { type: 'join_failed', reason: 'Lobby is full' });
					return;
				}
				const newPeerId = lobby.nextPeerId++;
				ws.lobbyCode = code;
				ws.peerId = newPeerId;
				lobby.peers.set(newPeerId, ws);
				const existingPeerIds = [...lobby.peers.keys()].filter(id => id !== newPeerId);
				send(ws, { type: 'joined', code, peerId: newPeerId, existingPeers: existingPeerIds });
				for (const [pid, peerWs] of lobby.peers.entries()) {
					if (pid !== newPeerId) {
						send(peerWs, { type: 'peer_joined', peerId: newPeerId });
					}
				}
				break;
			}

			case 'signal': {
				const lobby = lobbies.get(ws.lobbyCode);
				if (!lobby) return;
				const targetWs = lobby.peers.get(msg.targetPeerId);
				if (!targetWs) return;
				send(targetWs, {
					type: 'signal',
					fromPeerId: ws.peerId,
					data: msg.data,
				});
				break;
			}

			case 'leave': {
				cleanupPeer(ws);
				break;
			}
		}
	});

	ws.on('close', () => {
		cleanupPeer(ws);
	});
});

function cleanupPeer(ws) {
	if (!ws.lobbyCode) return;
	const lobby = lobbies.get(ws.lobbyCode);
	if (!lobby) return;
	lobby.peers.delete(ws.peerId);
	for (const peerWs of lobby.peers.values()) {
		send(peerWs, { type: 'peer_left', peerId: ws.peerId });
	}
	if (ws.peerId === 1 || lobby.peers.size === 0) {
		lobbies.delete(ws.lobbyCode);
	}
	ws.lobbyCode = null;
	ws.peerId = null;
}

console.log('Signaling server listening on port ' + PORT);
