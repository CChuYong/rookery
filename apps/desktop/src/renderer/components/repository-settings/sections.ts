export type RepositorySettingsSectionId = "capabilities";

export interface RepositorySettingsSection {
  id: RepositorySettingsSectionId;
  labelKey: string;
  descriptionKey: string;
}

export const repositorySettingsSections: readonly RepositorySettingsSection[] = [
  {
    id: "capabilities",
    labelKey: "repositorySettings.capabilities",
    descriptionKey: "repositorySettings.capabilitiesNavDescription",
  },
];
