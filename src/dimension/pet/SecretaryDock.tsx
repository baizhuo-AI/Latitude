import type { Secretary } from "../types";
import { PetArtwork } from "./PetArtwork";
import type { useSecretaryPet } from "./useSecretaryPet";
import type { NoticePreferences, PetNotice } from "../pet-notices";
import { usePetPose } from "./usePetPose";
import "./pet.css";

interface PetProps { pet: ReturnType<typeof useSecretaryPet>; secretary: Secretary; notice?: PetNotice | null; preferences?: NoticePreferences; onActivate?: () => void; label?: string }

const DOCK_STATE_LABEL: Record<Secretary["state"], string> = {
  ready: "在",
  thinking: "处理中",
  presenting: "找你",
};

export function SecretaryDock({ pet, secretary, notice, preferences, onActivate, label = "打开对话" }: PetProps) {
  const pose = usePetPose(pet.state);
  const away = pet.state.mode === "floating" || pet.state.dragging;
  return (
    <div ref={pet.setDockRef} className="latitude-pet-dock" data-away={away} data-over={pet.state.dragging && pet.state.overDock} aria-label="秘书形象框">
      {/* Keep the drag source mounted until release; it owns pointer capture. */}
      <button type="button" className="latitude-pet-grab" aria-label={label} title="点我说话，按住可拖到桌面" data-secretary-launcher tabIndex={away ? -1 : 0} aria-hidden={away}
        style={{ opacity: away ? 0 : 1, position: away ? "absolute" : undefined, pointerEvents: away && !pet.state.dragging ? "none" : undefined }}
        {...pet.handlers("dock", onActivate)}>
        <span className="latitude-pet-dock-frame dim-portrait" data-restoring={pose === "returning"}>
          <span className="latitude-pet-dock-portrait-window">
            <PetArtwork secretary={secretary} notice={notice} preferences={preferences} expression={pose}
              variant={away ? "pet" : "portrait"} />
          </span>
          <span className="dim-badge">{secretary.connectionState === "unavailable" ? "未连接"
            : secretary.connectionState === "starting" ? "连接中" : DOCK_STATE_LABEL[secretary.state]}</span>
        </span>
      </button>
      {away ? <>
        <span>{pet.state.dragging && pet.state.overDock ? "松手回到框里" : "她在桌面上"}</span>
        <button className="dim-btn dim-btn--quiet" type="button" onClick={pet.recall}>叫回来</button>
      </> : <span className="latitude-pet-dock-hint">点我说话，按住拖出</span>}
      {pet.error && <p role="alert" className="dim-meta">{pet.error}</p>}
    </div>
  );
}

export function BrowserPet({ pet, secretary, notice, preferences }: PetProps) {
  const pose = usePetPose(pet.state);
  if (pet.native || (pet.state.mode === "docked" && !pet.state.dragging)) return null;
  return <div ref={pet.setFloatingRef} className="latitude-pet-browser" data-dragging={pet.state.dragging} style={{ transform: pet.floatingTransform }}>
    <button type="button" className="latitude-pet-grab" aria-label="桌宠，点击说话或拖回形象框" {...pet.handlers("pet")}>
      <PetArtwork secretary={secretary} notice={notice} preferences={preferences} expression={pose} />
    </button>
    {!pet.state.dragging && <button className="dim-btn dim-btn--quiet latitude-pet-return" type="button" onClick={pet.recall}>回到框里</button>}
  </div>;
}
