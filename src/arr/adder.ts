import type { RadarrClient } from './radarr.js';
import type { AddOptions } from './types.js';

/** Raised when an approved candidate cannot be resolved inside Radarr. */
export class TitleNotFoundError extends Error {
  constructor(
    readonly remoteId: number,
    readonly title: string,
  ) {
    super(`Radarr has no match for "${title}" (tmdb ${remoteId})`);
    this.name = 'TitleNotFoundError';
  }
}

/** One of Radarr's quality profiles, as the Discord layer needs it. */
export interface QualityProfile {
  id: number;
  name: string;
}

/** Where approved titles land. Names are resolved to ids on first use. */
export interface ArrTargetConfig {
  /** exact root folder path; Radarr's first root folder when unset */
  rootFolder?: string;
  /** quality profile name; Radarr's first profile when unset */
  qualityProfile?: string;
  searchOnAdd: boolean;
}

export interface AddedTitle {
  remoteId: number;
  /** Radarr's own movie id */
  localId: number;
  title: string;
  rootFolderPath: string;
  qualityProfileId: number;
  qualityProfileName: string;
}

/** Per-approval overrides of the configured placement. */
export interface AddOverrides {
  /** the profile the user picked in Discord; the default when absent */
  qualityProfileId?: number;
}

/** What the Discord layer needs from the Radarr side, and nothing more. */
export interface TitleAdder {
  add(
    remoteId: number,
    title: string,
    year: number | null,
    overrides?: AddOverrides,
  ): Promise<AddedTitle>;
  /** Every profile Radarr offers, for the Discord dropdown. */
  qualityProfiles(): Promise<QualityProfile[]>;
  /** The profile an approval lands in when the user picked none. */
  defaultQualityProfile(): Promise<QualityProfile>;
}

/**
 * Turns an approved suggestion into a monitored movie in Radarr, which is
 * what actually hands the download to qBittorrent.
 *
 * Placement (root folder + quality profile) is read from Radarr itself
 * and cached for the process lifetime — they change about once a year,
 * and re-reading them on every approval would just add latency to a
 * reaction the user is watching. The profile *list* is cached in the
 * same pass, so building the Discord dropdown costs no extra request.
 *
 * The cached profile is only the default: an approval may name another
 * one, and `add()` will honour it without disturbing the cache.
 */
export class ArrAdder implements TitleAdder {
  private placement: AddOptions | null = null;
  private profiles: QualityProfile[] | null = null;

  constructor(
    private readonly radarr: RadarrClient,
    private readonly target: ArrTargetConfig,
  ) {}

  async add(
    remoteId: number,
    title: string,
    _year: number | null,
    overrides: AddOverrides = {},
  ): Promise<AddedTitle> {
    const defaults = await this.options();
    const opts: AddOptions =
      overrides.qualityProfileId === undefined
        ? defaults
        : { ...defaults, qualityProfileId: overrides.qualityProfileId };

    const lookup = await this.radarr.lookupByTmdbId(remoteId);
    if (!lookup) throw new TitleNotFoundError(remoteId, title);

    const added = await this.radarr.addMovie(lookup, opts);
    return {
      remoteId,
      localId: added.id,
      title: added.title,
      rootFolderPath: opts.rootFolderPath,
      qualityProfileId: opts.qualityProfileId,
      qualityProfileName: await this.profileName(opts.qualityProfileId),
    };
  }

  async qualityProfiles(): Promise<QualityProfile[]> {
    if (!this.profiles) {
      const raw = await this.radarr.qualityProfiles();
      this.profiles = raw.map((p) => ({ id: p.id, name: p.name }));
    }
    return this.profiles;
  }

  /**
   * Deliberately independent of `options()`: naming the default profile
   * for the Discord dropdown must not depend on the root folder being
   * resolvable too.
   */
  async defaultQualityProfile(): Promise<QualityProfile> {
    return this.resolveProfile(await this.qualityProfiles());
  }

  /** The profile's name, or its bare id when Radarr no longer knows it. */
  private async profileName(id: number): Promise<string> {
    const profiles = await this.qualityProfiles();
    return profiles.find((p) => p.id === id)?.name ?? `profile ${id}`;
  }

  private resolveProfile(profiles: QualityProfile[]): QualityProfile {
    const profile = this.target.qualityProfile
      ? profiles.find((p) => p.name.toLowerCase() === this.target.qualityProfile!.toLowerCase())
      : profiles[0];
    if (!profile) {
      throw new Error(
        this.target.qualityProfile
          ? `Quality profile "${this.target.qualityProfile}" not found in Radarr`
          : 'Radarr has no quality profiles configured',
      );
    }
    return profile;
  }

  private async options(): Promise<AddOptions> {
    if (this.placement) return this.placement;

    const [folders, profiles] = await Promise.all([
      this.radarr.rootFolders(),
      this.qualityProfiles(),
    ]);

    const folder = this.target.rootFolder
      ? folders.find((f) => f.path === this.target.rootFolder)
      : folders[0];
    if (!folder) {
      throw new Error(
        this.target.rootFolder
          ? `Root folder "${this.target.rootFolder}" not configured in Radarr`
          : 'Radarr has no root folders configured',
      );
    }

    this.placement = {
      rootFolderPath: folder.path,
      qualityProfileId: this.resolveProfile(profiles).id,
      searchOnAdd: this.target.searchOnAdd,
    };
    return this.placement;
  }
}
