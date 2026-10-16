export {
  addSceneToSet,
  advance,
  copyScene,
  createSet,
  cycleSet,
  deleteSet,
  journalPadIds,
  launchScene,
  pasteClipboard,
  pickWanderCandidate,
  record,
  removeSceneFromJournal,
  removeSceneFromSet,
  resetLane,
  sceneColor,
  sceneIdsForPads,
  setMacro,
  setMixer,
  setPadIds,
  setWander,
  toggleLock,
  toggleMute,
} from "./journal.ts";
export {
  captureGenerator,
  captureLane,
  capturePaths,
  captureSurface,
  setCaptureDepth,
  setCaptureIntensity,
  setCaptureScope,
} from "./capture.ts";
import { LANES, type LaneId, type Project } from "./types.ts";

export function audibleEvents(project: Project, phraseLanes: Record<LaneId, { velocity: number; lane: LaneId }[]>): { lane: LaneId; velocity: number }[] {
  const out: { lane: LaneId; velocity: number }[] = [];
  for (const lane of LANES) {
    if (project.mute[lane]) continue;
    for (const event of phraseLanes[lane]) {
      out.push({ lane, velocity: event.velocity * project.mixer[lane] * project.mixer.master });
    }
  }
  return out;
}

