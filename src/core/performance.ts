export {
  addSceneToSet,
  advance,
  clampJournalPage,
  createSet,
  cycleSet,
  deleteSet,
  ensureTrailingEmpty,
  journalPadIds,
  journalPageCount,
  laneHeard,
  launchScene,
  pasteClipboard,
  pickWanderCandidate,
  record,
  recordInto,
  removeSceneFromJournal,
  removeSceneFromSet,
  resetLane,
  sceneColor,
  sceneIdsForPads,
  setMacro,
  setMixer,
  setPadIds,
  setWander,
  toggleClipboard,
  toggleLock,
  toggleMute,
  toggleSolo,
  wanderCandidates,
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
import { laneHeard } from "./journal.ts";

export function audibleEvents(project: Project, phraseLanes: Record<LaneId, { velocity: number; lane: LaneId }[]>): { lane: LaneId; velocity: number }[] {
  const out: { lane: LaneId; velocity: number }[] = [];
  for (const lane of LANES) {
    if (!laneHeard(project, lane)) continue;
    for (const event of phraseLanes[lane]) {
      out.push({ lane, velocity: event.velocity * project.mixer[lane] * project.mixer.master });
    }
  }
  return out;
}

