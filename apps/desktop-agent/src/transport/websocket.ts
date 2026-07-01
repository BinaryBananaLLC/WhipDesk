import type { Server, IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { log } from "../logger";
import type { AgentContext } from "../server";
import { answerWebRtcOffer, type WebRtcAnswer } from "./webrtc";

/**
 * LAN endpoint at `/ws`. Same-Wi-Fi browsers (the QR/link printed by the CLI) connect over WebRTC
 * just like remote ones — the ONLY differences are that signaling rides this WebSocket instead of
 * Firebase, and ICE uses **host candidates only** (`iceServers: []`), so a CLI/LAN connection never
 * touches our STUN/TURN. The control session + the H.264 video then flow P2P, direct on the LAN.
 */
export function attachWebSocket(server: Server, ctx: AgentContext): void {
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws, req) => onConnection(ws, req, ctx));
  wss.on("error", (error) => log.error("ws server error", error.message));
}

function onConnection(ws: WebSocket, req: IncomingMessage, ctx: AgentContext): void {
  let answer: WebRtcAnswer | null = null;
  // The LAN IP identifies the client for persistent PIN brute-force throttling.
  const clientId = req.socket.remoteAddress ?? undefined;

  const send = (obj: unknown) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* socket may have closed */
      }
    }
  };

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;
    let msg: { kind?: string; sdp?: string; candidate?: unknown };
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (msg.kind === "offer" && typeof msg.sdp === "string" && !answer) {
      void answerWebRtcOffer(
        ctx,
        msg.sdp,
        () => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
        {
          clientId,
          iceServers: [], // LAN: host candidates only — never use STUN/TURN for a same-Wi-Fi peer.
          onLocalCandidate: (candidate) => send({ kind: "candidate", candidate }),
        },
      )
        .then((a) => {
          if (!a) {
            send({ kind: "error", message: "WebRTC unavailable on host" });
            return;
          }
          answer = a;
          send({ kind: "answer", sdp: a.answerSdp });
        })
        .catch((error) => log.warn("LAN WebRTC answer failed:", (error as Error).message));
    } else if (msg.kind === "candidate" && msg.candidate && answer) {
      answer.addCandidate(msg.candidate);
    }
  });

  const close = () => {
    answer?.close();
    answer = null;
  };
  ws.on("close", close);
  ws.on("error", close);
}
