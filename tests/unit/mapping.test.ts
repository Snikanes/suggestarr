import { describe, expect, it } from 'vitest';
import {
  mapRadarrMovieToTitle,
  resolvePosterUrl,
  type RadarrImage,
} from '../../src/arr/types.js';

describe('resolvePosterUrl', () => {
  const baseUrl = 'http://arr.test:1234';

  it('prefers absolute remoteUrl', () => {
    const images: RadarrImage[] = [
      { coverType: 'poster', url: '/api/v3/cover?x=1', remoteUrl: 'https://cdn.example/p.jpg' },
    ];
    expect(resolvePosterUrl(images, baseUrl)).toBe('https://cdn.example/p.jpg');
  });

  it('makes relative url absolute against the *arr base URL', () => {
    const images: RadarrImage[] = [
      { coverType: 'cover', url: '/api/v3/cover?coverType=cover&id=3' },
    ];
    expect(resolvePosterUrl(images, baseUrl)).toBe(
      'http://arr.test:1234/api/v3/cover?coverType=cover&id=3',
    );
  });

  it('selects poster or cover coverTypes, ignoring others', () => {
    const images: RadarrImage[] = [
      { coverType: 'banner', url: '/api/v3/cover?coverType=banner' },
      { coverType: 'poster', url: '/api/v3/cover?coverType=poster' },
    ];
    expect(resolvePosterUrl(images, baseUrl)).toBe(
      'http://arr.test:1234/api/v3/cover?coverType=poster',
    );
  });

  it('returns null for empty and undefined image lists', () => {
    expect(resolvePosterUrl([], baseUrl)).toBeNull();
    expect(resolvePosterUrl(undefined, baseUrl)).toBeNull();
    expect(resolvePosterUrl(null, baseUrl)).toBeNull();
  });
});

describe('mapRadarrMovieToTitle', () => {
  const baseUrl = 'http://radarr.test:7878';

  it('maps a monitored movie with TMDB id and remote poster', () => {
    const t = mapRadarrMovieToTitle(
      {
        id: 1,
        title: 'The Matrix',
        sortTitle: 'matrix',
        originalTitle: null,
        year: 1999,
        tmdbId: 603,
        monitored: true,
        images: [
          { coverType: 'poster', url: '/x', remoteUrl: 'https://cdn.example/m.jpg' },
        ],
      },
      baseUrl,
    );
    expect(t).toEqual({
      localId: 1,
      remoteId: 603,
      title: 'The Matrix',
      year: 1999,
      monitored: true,
      posterUrl: 'https://cdn.example/m.jpg',
      addedAt: null,
      hasFile: false,
    });
  });

  it('maps null tmdbId/year to null remoteId/year and no images to null poster', () => {
    const t = mapRadarrMovieToTitle(
      {
        id: 2,
        title: 'Local Film',
        sortTitle: 'local film',
        originalTitle: 'Local Film',
        year: null,
        tmdbId: null,
        monitored: false,
        images: [],
      },
      baseUrl,
    );
    expect(t.remoteId).toBeNull();
    expect(t.year).toBeNull();
    expect(t.monitored).toBe(false);
    expect(t.posterUrl).toBeNull();
  });
});

describe('added/hasFile mapping', () => {
  it('carries Radarr\'s added timestamp and file flag through', () => {
    const t = mapRadarrMovieToTitle(
      {
        id: 1,
        title: 'The Matrix',
        sortTitle: 'matrix',
        year: 1999,
        tmdbId: 603,
        monitored: true,
        images: [],
        added: '2026-02-01T18:30:00Z',
        hasFile: true,
      },
      'http://radarr.test:7878',
    );
    expect(t.addedAt).toBe('2026-02-01T18:30:00Z');
    expect(t.hasFile).toBe(true);
  });

});
