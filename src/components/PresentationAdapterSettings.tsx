import { Puzzle } from "lucide-react";
import { useState } from "react";
import { usePresentationAdapters } from "../presentation-adapters";
import { store } from "../store";
import { SettingField, SettingsSwitch } from "./SettingsControls";
import { SettingsCardMessage, SettingsSection } from "./SettingsSection";

export function PresentationAdapterSettings() {
  const { adapters } = usePresentationAdapters();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function toggle(id: string, enabled: boolean) {
    setPending(id);
    setError("");
    try {
      await store.setPresentationAdapterEnabled(id, enabled);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not change adapter.",
      );
    } finally {
      setPending(null);
    }
  }
  return (
    <SettingsSection
      id="extension-adapters"
      icon={<Puzzle size={14} />}
      title="Extension adapters"
      description="Choose how Pi extensions appear in Inspire. These switches change the GUI, not which extensions Pi runs."
    >
      {adapters.length ? (
        adapters.map((adapter) => (
          <SettingField
            key={adapter.id}
            label={adapter.name}
            status={
              adapter.warning ? (
                <span role="alert">{adapter.warning}</span>
              ) : undefined
            }
          >
            <SettingsSwitch
              label={adapter.name}
              checked={adapter.enabled}
              disabled={pending !== null}
              busy={pending === adapter.id}
              onChange={(enabled) => void toggle(adapter.id, enabled)}
              state={adapter.enabled ? "On" : "Off"}
            />
          </SettingField>
        ))
      ) : (
        <SettingsCardMessage>
          No adapters configured. Add adapter files to your custom presentation
          profile.
        </SettingsCardMessage>
      )}
      {error ? <SettingsCardMessage error>{error}</SettingsCardMessage> : null}
    </SettingsSection>
  );
}
