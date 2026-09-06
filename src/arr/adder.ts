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
}

/** What the Discord layer needs from the Radarr side, and nothing more. */
export interface TitleAdder {
  add(remoteId: number, title: string, year: number | null): Promise<AddedTitle>;
}

/**
 * Turns an approved suggestion into a monitored movie in Radarr, which is
 * what actually hands the download to qBittorrent.
 *
 * Placement (root folder + quality profile) is read from Radarr itself
 * and cached for the process lifetime — they change about once a year,
 * and re-reading them on every approval would just add latency to a
 * reaction the user is watching.
 */
export class ArrAdder implements TitleAdder {
  private placement: AddOptions | null = null;

  constructor(
    private readonly radarr: RadarrClient,
    private readonly target: ArrTargetConfig,
  ) {}

  async add(remoteId: number, title: string, _year: number | null): Promise<AddedTitle> {
    const opts = await this.options();
    const lookup = await this.radarr.lookupByTmdbId(remoteId);
    if (!lookup) throw new TitleNotFoundError(remoteId, title);

    const added = await this.radarr.addMovie(lookup, opts);
    return {
      remoteId,
      localId: added.id,
      title: added.title,
      rootFolderPath: opts.rootFolderPath,
      qualityProfileId: opts.qualityProfileId,
    };
  }

  private async options(): Promise<AddOptions> {
    if (this.placement) return this.placement;

    const [folders, profiles] = await Promise.all([
      this.radarr.rootFolders(),
      this.radarr.qualityProfiles(),
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

    this.placement = {
      rootFolderPath: folder.path,
      qualityProfileId: profile.id,
      searchOnAdd: this.target.searchOnAdd,
    };
    return this.placement;
  }
}
