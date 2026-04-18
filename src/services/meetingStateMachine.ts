import { HttpError } from "../middleware/errorHandler";
import type { MeetingStatus } from "../types/meeting";

const allowedTransitions: Record<MeetingStatus, Set<MeetingStatus>> = {
  pending: new Set(["starting", "failed_audio_pool_busy", "failed_connect_ws_audio"]),
  starting: new Set(["in_meeting", "failed_audio_pool_busy", "failed_connect_ws_audio", "stopped_during_meeting"]),
  in_meeting: new Set(["stopped_during_meeting", "completed", "failed_audio_pool_busy", "failed_connect_ws_audio"]),
  failed_audio_pool_busy: new Set(),
  failed_connect_ws_audio: new Set(),
  stopped_during_meeting: new Set(),
  completed: new Set()
};

export class MeetingStateMachine {
  canTransition(from: MeetingStatus, to: MeetingStatus): boolean {
    return allowedTransitions[from].has(to);
  }

  assertTransition(from: MeetingStatus, to: MeetingStatus): void {
    if (from === to) {
      return;
    }

    if (!this.canTransition(from, to)) {
      throw new HttpError(409, `Invalid meeting transition from '${from}' to '${to}'`);
    }
  }
}
