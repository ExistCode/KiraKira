import { describe, expect, it, vi } from "vitest";
import { connectLiveVoice, type LiveMedia } from "./live-client";
import type { LiveVoiceEvent } from "./live-protocol";

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  sent: unknown[] = [];
  constructor(readonly label: string) { super(); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close = vi.fn(() => { this.readyState = "closed"; });
  open() { this.readyState = "open"; this.dispatchEvent(new Event("open")); }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
}

class FakePeer extends EventTarget {
  channel: FakeChannel | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
  tracks: MediaStreamTrack[] = [];
  close = vi.fn();
  addTrack(track: MediaStreamTrack) { this.tracks.push(track); }
  createDataChannel(label: string) { this.channel = new FakeChannel(label); return this.channel; }
  async createOffer() { return { type: "offer" as const, sdp: "offer-sdp" }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
  async setRemoteDescription(description: RTCSessionDescriptionInit) { this.remoteDescription = description; }
}

function setup() {
  const track = { kind: "audio", enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const peer = new FakePeer();
  const audio = { srcObject: null as MediaProvider | null, play: vi.fn(async () => undefined), pause: vi.fn() };
  const media: LiveMedia = {
    getUserMedia: vi.fn(async () => stream),
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
    createAudioElement: () => audio as unknown as HTMLAudioElement,
  };
  const events: LiveVoiceEvent[] = [];
  const onConnectionLost = vi.fn();
  return { track, peer, audio, media, events, onConnectionLost };
}

describe("connectLiveVoice", () => {
  it("negotiates through requestAnswer on an oai-events channel and forwards parsed events", async () => {
    const { peer, media, events, onConnectionLost } = setup();
    const requestAnswer = vi.fn(async () => ({ sdp: "answer-sdp", sessionId: "live_1" }));

    const connection = await connectLiveVoice({ requestAnswer, onEvent: (event) => events.push(event), onConnectionLost, media });

    expect(peer.channel?.label).toBe("oai-events");
    expect(requestAnswer).toHaveBeenCalledWith("offer-sdp");
    expect(peer.remoteDescription).toEqual({ type: "answer", sdp: "answer-sdp" });
    expect(connection.sessionId).toBe("live_1");

    peer.channel?.receive({ type: "session.output_transcript.delta", event_id: "e", delta: "Hi" });
    expect(events).toEqual([{ kind: "transcript", role: "assistant", delta: "Hi" }]);
  });

  it("only sends once the channel is open", async () => {
    const { peer, media, onConnectionLost } = setup();
    const connection = await connectLiveVoice({ requestAnswer: async () => ({ sdp: "a", sessionId: "s" }), onEvent: () => undefined, onConnectionLost, media });

    connection.send({ type: "response.create" });
    expect(peer.channel?.sent).toEqual([]);
    peer.channel?.open();
    connection.send({ type: "response.create" });
    expect(peer.channel?.sent).toEqual([{ type: "response.create" }]);
  });

  it("mutes by disabling the mic track and telling the session", async () => {
    const { peer, track, media, onConnectionLost } = setup();
    const connection = await connectLiveVoice({ requestAnswer: async () => ({ sdp: "a", sessionId: "s" }), onEvent: () => undefined, onConnectionLost, media });
    peer.channel?.open();

    connection.setMuted(true);
    expect(track.enabled).toBe(false);
    expect(peer.channel?.sent).toEqual([{ type: "session.input_audio.mute" }]);
    connection.setMuted(false);
    expect(track.enabled).toBe(true);
    expect(peer.channel?.sent).toEqual([{ type: "session.input_audio.mute" }, { type: "session.input_audio.unmute" }]);
  });

  it("closes gracefully once, after session.closed arrives", async () => {
    const { peer, track, audio, media, onConnectionLost } = setup();
    const connection = await connectLiveVoice({ requestAnswer: async () => ({ sdp: "a", sessionId: "s" }), onEvent: () => undefined, onConnectionLost, media });
    peer.channel?.open();

    const closing = connection.close();
    expect(peer.channel?.sent).toEqual([{ type: "session.close" }]);
    peer.channel?.receive({ type: "session.closed", event_id: "e", reason: "close_requested" });
    await closing;
    await connection.close();

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(audio.srcObject).toBeNull();
    expect(peer.channel?.sent).toHaveLength(1);
    expect(onConnectionLost).not.toHaveBeenCalled();
  });

  it("cleans up and rejects when the answer request fails", async () => {
    const { peer, track, media, onConnectionLost } = setup();
    await expect(connectLiveVoice({
      requestAnswer: async () => { throw new Error("401"); },
      onEvent: () => undefined,
      onConnectionLost,
      media,
    })).rejects.toThrow("401");
    expect(track.stop).toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalled();
  });

  it("reports a failed peer connection as lost", async () => {
    const { peer, media, onConnectionLost } = setup();
    await connectLiveVoice({ requestAnswer: async () => ({ sdp: "a", sessionId: "s" }), onEvent: () => undefined, onConnectionLost, media });
    peer.connectionState = "failed";
    peer.dispatchEvent(new Event("connectionstatechange"));
    expect(onConnectionLost).toHaveBeenCalledTimes(1);
  });
});
