export type ActiveSpeaker = "candidate" | "assistant";
export type DuplexMode = "single_assistant" | "duplex";
export type VideoAudioSource = "mic" | "tts" | "auto";

type AssistantTurnState = "idle" | "thinking" | "speaking";

export class SessionOrchestrator {
  private activeSpeaker: ActiveSpeaker = "assistant";
  private duplexMode: DuplexMode;
  private videoAudioSource: VideoAudioSource;
  private assistantTurnState: AssistantTurnState = "idle";
  private turnOwnership: "candidate" | "assistant" | "none" = "none";

  constructor(input?: { duplexMode?: DuplexMode; videoAudioSource?: VideoAudioSource }) {
    this.duplexMode = input?.duplexMode ?? "single_assistant";
    this.videoAudioSource = input?.videoAudioSource ?? "tts";
  }

  onVadUtterance(): ActiveSpeaker {
    this.activeSpeaker = "candidate";
    this.turnOwnership = "candidate";
    return this.activeSpeaker;
  }

  onAssistantTurnStart(state: AssistantTurnState = "speaking"): ActiveSpeaker {
    this.assistantTurnState = state;
    this.activeSpeaker = "assistant";
    this.turnOwnership = "assistant";
    return this.activeSpeaker;
  }

  onAssistantTurnEnd(): ActiveSpeaker {
    this.assistantTurnState = "idle";
    this.turnOwnership = "none";
    this.activeSpeaker = "assistant";
    return this.activeSpeaker;
  }

  forceActiveSpeaker(speaker: ActiveSpeaker): ActiveSpeaker {
    this.activeSpeaker = speaker;
    this.turnOwnership = speaker;
    if (speaker === "assistant" && this.assistantTurnState === "idle") {
      this.assistantTurnState = "speaking";
    }
    if (speaker === "candidate") {
      this.assistantTurnState = "idle";
    }
    return this.activeSpeaker;
  }

  setDuplexMode(mode: DuplexMode): void {
    this.duplexMode = mode;
  }

  setVideoAudioSource(source: VideoAudioSource): void {
    this.videoAudioSource = source;
  }

  resolveAudioSource(): "mic" | "tts" {
    if (this.videoAudioSource === "mic") return "mic";
    if (this.videoAudioSource === "tts") return "tts";
    // "auto"
    return this.activeSpeaker === "candidate" ? "mic" : "tts";
  }

  snapshot(): {
    activeSpeaker: ActiveSpeaker;
    duplexMode: DuplexMode;
    videoAudioSource: VideoAudioSource;
    turnOwnership: "candidate" | "assistant" | "none";
    assistantTurnState: AssistantTurnState;
  } {
    return {
      activeSpeaker: this.activeSpeaker,
      duplexMode: this.duplexMode,
      videoAudioSource: this.videoAudioSource,
      turnOwnership: this.turnOwnership,
      assistantTurnState: this.assistantTurnState
    };
  }
}

