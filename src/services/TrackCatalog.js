// === Catálogo de previews (iTunes / Deezer) ===
// Spotify eliminó las previews del Web API y exige Premium al dueño de la
// app para cualquier llamada: estas fuentes dan MP3 de 30s gratis y sin auth.
const TRACK_CACHE_TTL = 86400000; // 24 horas
const TRACK_CACHE_MAX = 500;
const MIN_TRACK_MS = 60000;
const MAX_TRACK_MS = 480000;

const normalizeText = (s) =>
    (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const fetchJson = async (url, timeoutMs = 8000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
};

const searchItunesTracks = async (artist) => {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(artist)}&entity=song&country=ES&limit=50`;
    const data = await fetchJson(url);
    const wanted = normalizeText(artist);
    return (data.results || [])
        .filter(r =>
            r.previewUrl &&
            r.trackTimeMillis >= MIN_TRACK_MS && r.trackTimeMillis <= MAX_TRACK_MS &&
            normalizeText(r.artistName).includes(wanted)
        )
        .map(r => ({
            id: `itunes-${r.trackId}`,
            title: r.trackName,
            artist: r.artistName,
            year: r.releaseDate ? parseInt(r.releaseDate.slice(0, 4), 10) : null,
            previewUrl: r.previewUrl,
            albumImage: r.artworkUrl100 ? r.artworkUrl100.replace('100x100', '300x300') : null,
            albumName: r.collectionName || null,
        }));
};

const searchDeezerTracks = async (artist) => {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${artist}"`)}&limit=50`;
    const data = await fetchJson(url);
    const wanted = normalizeText(artist);
    return (data.data || [])
        .filter(t =>
            t.preview &&
            t.duration >= MIN_TRACK_MS / 1000 && t.duration <= MAX_TRACK_MS / 1000 &&
            normalizeText(t.artist?.name).includes(wanted)
        )
        .map(t => ({
            id: `deezer-${t.id}`,
            title: t.title,
            artist: t.artist.name,
            year: null,
            previewUrl: t.preview,
            albumImage: t.album?.cover_medium || null,
            albumName: t.album?.title || null,
        }));
};

// Caché en memoria: el cliente pide las canciones de un artista y recibe
// MP3s de 30s reproducibles sin Spotify
const trackCache = new Map(); // artista normalizado -> { tracks, fetchedAt }

export const tracksHandler = async (req, res) => {
    const artist = typeof req.query.artist === 'string'
        ? req.query.artist.trim().slice(0, 100)
        : '';
    if (!artist) {
        res.status(400).json({ error: 'Parámetro artist requerido' });
        return;
    }

    const cacheKey = normalizeText(artist);
    const cached = trackCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < TRACK_CACHE_TTL) {
        res.json({ tracks: cached.tracks });
        return;
    }

    let tracks = [];
    try {
        tracks = await searchItunesTracks(artist);
    } catch (error) {
        console.error(`iTunes falló para "${artist}":`, error.message);
    }
    if (tracks.length === 0) {
        try {
            tracks = await searchDeezerTracks(artist);
        } catch (error) {
            console.error(`Deezer falló para "${artist}":`, error.message);
        }
    }

    if (tracks.length === 0) {
        res.status(404).json({ error: 'No hay canciones con preview para este artista', tracks: [] });
        return;
    }

    if (trackCache.size >= TRACK_CACHE_MAX) {
        trackCache.delete(trackCache.keys().next().value);
    }
    trackCache.set(cacheKey, { tracks, fetchedAt: Date.now() });
    res.json({ tracks });
};
